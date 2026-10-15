// Goal: the static documents match the database and change only when it does. Method: issue credentials, publish,
// and read the files back through the same checks a verifier uses; revoke and watch exactly one bit appear; rotate
// and revoke a key and watch the documents follow; delete a file and watch it come back; check who may revoke.

import { createMigratedTestDatabase, inRole, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemRng } from "../../platform/rng.ts";
import { createDevelopmentSigner } from "../../platform/signer.ts";
import { createMemoryStorage } from "../../platform/storage-memory.ts";
import { createFakeClock } from "../../sim/world.ts";
import { issuerDid } from "./documents.ts";
import { type Event, issueOnce } from "./issuing.ts";
import { DID_KEY, JWKS_KEY, publishedKeys, publishPassport, statusKey } from "./publish.ts";
import { isRevokedIn, verifyStatusList } from "./status-list.ts";

const ADMIN = "018f0000-0000-7000-8000-000000000c01";
const HOLDER = "018f0000-0000-7000-8000-000000000c02";
const OUTSIDER = "018f0000-0000-7000-8000-000000000c03";
const OWNER = "018f0000-0000-7000-8000-000000000c04";
const ORIGIN = "https://passport.example";
const NOW = Date.UTC(2026, 10, 1, 12);
const clock = createFakeClock(NOW);
const storage = createMemoryStorage(clock);
const signerA = createDevelopmentSigner({ keyId: "dev-pub-a", appEnvironment: "test" });
const signerB = createDevelopmentSigner({ keyId: "dev-pub-b", appEnvironment: "test" });
let db: TestDatabase;
let org = "";

const as = <T>(
    user: string,
    work: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<T>,
) => inRole(db.database, "aura_app", { actorKind: "user", userId: user, orgIds: [] }, work);
const worker = <T>(work: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<T>) =>
    inRole(db.database, "aura_worker", { actorKind: "worker", userId: null, orgIds: [] }, work);
const issuing = (signer: typeof signerA) => ({
    clock,
    rng: systemRng,
    signer,
    issuerDid: issuerDid(ORIGIN),
    issuerName: "AuraLand (development)",
    publicOrigin: ORIGIN,
});
const publishing = (signer: typeof signerA) => ({
    clock,
    storage,
    signer,
    issuerDid: issuerDid(ORIGIN),
    publicOrigin: ORIGIN,
});
const event = (n: number): Event => ({
    subjectUserId: HOLDER,
    issuerOrgId: org,
    eventId: `018f0000-0000-7000-8000-00000000f00${n}`,
    assurance: 0,
    expiresAtMs: null,
    claim: {
        kind: "contest_rank",
        event_title: `C${n}`,
        host_name: "Uni",
        rank: n,
        participants: 9,
        solved: 1,
        finalized_at: new Date(NOW).toISOString(),
    },
});
const read = async (key: string) => {
    const found = await storage.getSmall(key, 1_000_000);
    if (found.kind !== "found") throw new Error(`${key} is ${found.kind}`);
    return new TextDecoder().decode(found.bytes);
};
const credentialIds = async () =>
    await db.database.sql<
        { id: string; status_index: number }[]
    >`select id, status_index from credentials order by status_index`;

beforeAll(async () => {
    db = await createMigratedTestDatabase(9);
    const { sql } = db.database;
    await sql`insert into users (id, email, email_verified_at, platform_role) values (${ADMIN}, 'admin@example.com', now(), 'admin')`;
    await sql`insert into users (id, email, email_verified_at) values (${HOLDER}, 'h@example.com', now()), (${OUTSIDER}, 'o@example.com', now()), (${OWNER}, 'w@example.com', now())`;
    const [o] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'pub-uni', 'Uni') returning id`;
    org = o?.id ?? "";
    await sql`insert into memberships (org_id, user_id, role) values (${org}, ${OWNER}, 'owner')`;
    await worker(
        (tx) =>
            tx`select register_signing_key('dev-pub-a', 'ES256', ${tx.json(signerA.publicJwk())}, 'development', ${new Date(NOW)})`,
    );
    for (const n of [1, 2, 3]) await worker((tx) => issueOnce(tx, issuing(signerA), event(n)));
});
afterAll(async () => {
    await db.drop();
});

describe("publishing", () => {
    it("writes the documents once, and nothing again until something changes", async () => {
        expect(await worker((tx) => publishPassport(tx, publishing(signerA)))).toEqual([
            DID_KEY,
            JWKS_KEY,
            statusKey(0),
        ]);
        expect(await worker((tx) => publishPassport(tx, publishing(signerA)))).toEqual([]);
        const keys = await worker(publishedKeys);
        const list = await verifyStatusList(
            await read(statusKey(0)),
            keys,
            `${ORIGIN}/passport/status/0`,
        );
        expect(list.ok && [0, 1, 2].some((i) => isRevokedIn(list.bits, i))).toBe(false);
        expect(JSON.parse(await read(JWKS_KEY)).keys.map((k: { kid: string }) => k.kid)).toEqual([
            "dev-pub-a",
        ]);
        expect(await read(DID_KEY)).not.toContain('"d"');
    });

    it("rewrites a file that went missing even when its content is unchanged", async () => {
        await storage.remove(JWKS_KEY);
        expect(await worker((tx) => publishPassport(tx, publishing(signerA)))).toEqual([JWKS_KEY]);
    });
});

describe("revoking", () => {
    it("lets the issuer's admin or a platform administrator revoke, and nobody else", async () => {
        const [first, second] = await credentialIds();
        const revoke = (user: string, id: string, reason = "wrong rank") =>
            as(user, (tx) => tx`select revoke_credential(${id}, ${reason}, ${new Date(NOW)})`);
        await expect(revoke(OUTSIDER, first?.id ?? "")).rejects.toThrow(/no such credential/);
        await expect(revoke(HOLDER, first?.id ?? "")).rejects.toThrow(/no such credential/); // holders hide, they do not revoke
        await expect(revoke(OWNER, first?.id ?? "", "")).rejects.toThrow(/reason/);
        await revoke(OWNER, first?.id ?? "");
        await revoke(ADMIN, second?.id ?? "");
        await expect(revoke(OWNER, first?.id ?? "")).rejects.toThrow(/already revoked/);
    });

    it("sets exactly the revoked bits in the next list, and only that list is rewritten", async () => {
        const [first, second, third] = await credentialIds();
        expect(await worker((tx) => publishPassport(tx, publishing(signerA)))).toEqual([
            statusKey(0),
        ]);
        const list = await verifyStatusList(
            await read(statusKey(0)),
            await worker(publishedKeys),
            `${ORIGIN}/passport/status/0`,
        );
        if (!list.ok) throw new Error(list.reason);
        expect(
            [first, second, third].map((c) => isRevokedIn(list.bits, c?.status_index ?? 0)),
        ).toEqual([true, true, false]);
    });
});

describe("keys", () => {
    it("follow a rotation and a revocation, and the list is signed by the new key", async () => {
        await as(
            ADMIN,
            (tx) =>
                tx`select rotate_signing_key('dev-pub-b', 'ES256', ${tx.json(signerB.publicJwk())}, 'development', ${new Date(NOW)})`,
        );
        const written = await worker((tx) => publishPassport(tx, publishing(signerB)));
        expect(written).toEqual([DID_KEY, JWKS_KEY, statusKey(0)]);
        expect(JSON.parse(await read(JWKS_KEY)).keys.map((k: { kid: string }) => k.kid)).toEqual([
            "dev-pub-a",
            "dev-pub-b",
        ]);
        const keys = await worker(publishedKeys);
        expect(
            (await verifyStatusList(await read(statusKey(0)), keys, `${ORIGIN}/passport/status/0`))
                .ok,
        ).toBe(true);

        await as(
            ADMIN,
            (tx) => tx`select revoke_signing_key('dev-pub-a', 'drill', ${new Date(NOW)})`,
        );
        await worker((tx) => publishPassport(tx, publishing(signerB)));
        expect(JSON.parse(await read(JWKS_KEY)).keys.map((k: { kid: string }) => k.kid)).toEqual([
            "dev-pub-b",
        ]);
        expect(await read(DID_KEY)).not.toContain("dev-pub-a");
    });
});
