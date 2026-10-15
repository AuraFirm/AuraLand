// Goal: the key-rotation and compromise drill of the runbook, run for real against PostgreSQL. Rotating keeps old
// credentials verifying; revoking a key makes its credentials stop verifying; signing them again with the active key
// brings them back with the same id, claims and place in the revocation list; a credential that was itself revoked is
// left alone; and nothing else may rewrite what was signed.

import { createMigratedTestDatabase, inRole, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemRng } from "../../platform/rng.ts";
import { createDevelopmentSigner } from "../../platform/signer.ts";
import { createMemoryStorage } from "../../platform/storage-memory.ts";
import { createFakeClock } from "../../sim/world.ts";
import { issuerDid } from "./documents.ts";
import { type Event, issueOnce } from "./issuing.ts";
import { publishedKeys, publishPassport } from "./publish.ts";
import { reissueRevoked } from "./reissue.ts";
import { verifyCredentialJwt } from "./verify.ts";

const ADMIN = "018f0000-0000-7000-8000-000000000e01";
const HOLDER = "018f0000-0000-7000-8000-000000000e02";
const ORIGIN = "https://passport.example";
const NOW = Date.UTC(2026, 10, 1, 12);
const clock = createFakeClock(NOW);
const storage = createMemoryStorage(clock);
const keyA = createDevelopmentSigner({ keyId: "drill-a", appEnvironment: "test" });
const keyB = createDevelopmentSigner({ keyId: "drill-b", appEnvironment: "test" });
let db: TestDatabase;
let org = "";

const worker = <T>(work: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<T>) =>
    inRole(db.database, "aura_worker", { actorKind: "worker", userId: null, orgIds: [] }, work);
const admin = <T>(work: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<T>) =>
    inRole(db.database, "aura_app", { actorKind: "user", userId: ADMIN, orgIds: [] }, work);
const ctx = (signer: typeof keyA) => ({
    clock,
    rng: systemRng,
    signer,
    issuerDid: issuerDid(ORIGIN),
    issuerName: "AuraLand (development)",
    publicOrigin: ORIGIN,
});
const publish = (signer: typeof keyA) =>
    worker((tx) =>
        publishPassport(tx, {
            clock,
            storage,
            signer,
            issuerDid: issuerDid(ORIGIN),
            publicOrigin: ORIGIN,
        }),
    );
const event = (n: number): Event => ({
    subjectUserId: HOLDER,
    issuerOrgId: org,
    eventId: `018f0000-0000-7000-8000-00000000d00${n}`,
    assurance: 0,
    expiresAtMs: null,
    claim: {
        kind: "contest_rank",
        event_title: `Drill ${n}`,
        host_name: "Uni",
        rank: n,
        participants: 9,
        solved: 1,
        finalized_at: new Date(NOW).toISOString(),
    },
});
const rows = () => db.database.sql<
    {
        id: string;
        vc_jwt: string;
        kid: string;
        status_list: number;
        status_index: number;
        claim: { event_title: string };
        revoked_at: Date | null;
        reissued_at: Date | null;
    }[]
>`
    select id, vc_jwt, kid, status_list, status_index, claim, revoked_at, reissued_at from credentials order by claim->>'event_title'`;
const outcomes = async () => {
    const keys = await worker(publishedKeys);
    return Promise.all(
        (await rows()).map(
            async (r) => (await verifyCredentialJwt(r.vc_jwt, keys, NOW + 1000)).outcome,
        ),
    );
};

beforeAll(async () => {
    db = await createMigratedTestDatabase(9);
    const { sql } = db.database;
    await sql`insert into users (id, email, email_verified_at, platform_role) values (${ADMIN}, 'a@example.com', now(), 'admin')`;
    await sql`insert into users (id, email, email_verified_at) values (${HOLDER}, 'h@example.com', now())`;
    const [o] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'drill-uni', 'Uni') returning id`;
    org = o?.id ?? "";
    await worker(
        (tx) =>
            tx`select register_signing_key('drill-a', 'ES256', ${tx.json(keyA.publicJwk())}, 'development', ${new Date(NOW)})`,
    );
    for (const n of [1, 2, 3]) await worker((tx) => issueOnce(tx, ctx(keyA), event(n)));
    await publish(keyA);
});
afterAll(async () => {
    await db.drop();
});

describe("the drill", () => {
    it("1. rotating keeps every credential verifying, and new ones use the new key", async () => {
        await admin(
            (tx) =>
                tx`select rotate_signing_key('drill-b', 'ES256', ${tx.json(keyB.publicJwk())}, 'development', ${new Date(NOW)})`,
        );
        await publish(keyB);
        await worker((tx) => issueOnce(tx, ctx(keyB), event(4)));
        expect(await outcomes()).toEqual(["valid", "valid", "valid", "valid"]);
        expect((await rows()).map((r) => r.kid)).toEqual([
            "drill-a",
            "drill-a",
            "drill-a",
            "drill-b",
        ]);
    });

    it("2. revoking the old key makes its credentials stop verifying, and the list says nothing false", async () => {
        const [, second] = await rows();
        await admin(
            (tx) =>
                tx`select revoke_credential(${second?.id ?? ""}, 'issued in error', ${new Date(NOW)})`,
        ); // revoked on its own
        await admin(
            (tx) => tx`select revoke_signing_key('drill-a', 'suspected leak', ${new Date(NOW)})`,
        );
        await publish(keyB);
        expect(await outcomes()).toEqual(["invalid", "invalid", "invalid", "valid"]);
    });

    it("3. signing again brings back the others with the same id, claims and place, and leaves the revoked one alone", async () => {
        const before = await rows();
        expect(
            await worker((tx) =>
                reissueRevoked(tx, { clock, signer: keyB, issuerDid: issuerDid(ORIGIN) }),
            ),
        ).toBe(2); // not the revoked one
        const after = await rows();
        expect(await outcomes()).toEqual(["valid", "invalid", "valid", "valid"]);
        for (const [i, row] of after.entries()) {
            expect([row.id, row.claim, row.status_list, row.status_index]).toEqual([
                before[i]?.id,
                before[i]?.claim,
                before[i]?.status_list,
                before[i]?.status_index,
            ]);
        }
        expect(after.map((r) => r.kid)).toEqual(["drill-b", "drill-a", "drill-b", "drill-b"]);
        expect(after[0]?.reissued_at).not.toBeNull();
        expect(after[3]?.reissued_at).toBeNull();
        expect(
            await worker((tx) =>
                reissueRevoked(tx, { clock, signer: keyB, issuerDid: issuerDid(ORIGIN) }),
            ),
        ).toBe(0); // done
        await publish(keyB);
    });
});

describe("the guard", () => {
    it("lets nothing else rewrite what was signed", async () => {
        const { sql } = db.database;
        await expect(sql`update credentials set vc_jwt = repeat('x', 200)`).rejects.toThrow(
            /never changes/,
        );
        await expect(sql`update credentials set kid = 'drill-b'`).rejects.toThrow(/never changes/);
        const [live] = await rows();
        await expect(
            worker(
                (tx) =>
                    tx`select reissue_credential(${live?.id ?? ""}, repeat('x', 200), 'drill-b', ${new Date(NOW)})`,
            ),
        ).rejects.toThrow(/only a credential whose key was revoked/);
    });
});
