// Goal: public verification reads only the published files and says the truth about each credential. Method: issue
// real credentials, publish them through the real publisher into storage, then verify with no database; damage the
// files in every way a broken or hostile store could; check that private and missing look the same.

import { makeUuidV7 } from "@aura/contracts/ids";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemRng } from "../../platform/rng.ts";
import { createDevelopmentSigner } from "../../platform/signer.ts";
import { createMemoryStorage } from "../../platform/storage-memory.ts";
import { createFakeClock } from "../../sim/world.ts";
import { issuerDid } from "./documents.ts";
import { type Event, issueOnce } from "./issuing.ts";
import { verifyPublished } from "./public-verify.ts";
import { credentialKey, JWKS_KEY, publishPassport, statusKey } from "./publish.ts";

const HOLDER = "018f0000-0000-7000-8000-000000000d01";
const ADMIN = "018f0000-0000-7000-8000-000000000d02";
const ORIGIN = "https://passport.example";
const NOW = Date.UTC(2026, 10, 1, 12);
const clock = createFakeClock(NOW);
const storage = createMemoryStorage(clock);
const signer = createDevelopmentSigner({ keyId: "dev-pv-1", appEnvironment: "test" });
let db: TestDatabase;
let org = "";
const ids: Record<string, string> = {};

const worker = <T>(work: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<T>) =>
    inRole(db.database, "aura_worker", { actorKind: "worker", userId: null, orgIds: [] }, work);
const publish = () =>
    worker((tx) =>
        publishPassport(tx, {
            clock,
            storage,
            signer,
            issuerDid: issuerDid(ORIGIN),
            publicOrigin: ORIGIN,
        }),
    );
const verify = (id: string, nowMs = NOW + 1000) =>
    verifyPublished(storage, { id: `crd_${id}`, publicOrigin: ORIGIN, nowMs });
const text = (key: string) => {
    const raw = storage.read(key);
    if (raw === undefined) throw new Error(`${key} is missing`);
    return new TextDecoder().decode(raw);
};
const event = (n: number, expiresAtMs: number | null = null): Event => ({
    subjectUserId: HOLDER,
    issuerOrgId: org,
    eventId: `018f0000-0000-7000-8000-00000000a00${n}`,
    assurance: 0,
    expiresAtMs,
    claim: {
        kind: "contest_rank",
        event_title: `Contest ${n}`,
        host_name: "Uni",
        rank: n,
        participants: 9,
        solved: 2,
        finalized_at: new Date(NOW).toISOString(),
    },
});
async function issue(name: string, n: number, expiresAtMs: number | null = null) {
    await worker((tx) =>
        issueOnce(
            tx,
            {
                clock,
                rng: systemRng,
                signer,
                issuerDid: issuerDid(ORIGIN),
                issuerName: "AuraLand (development)",
                publicOrigin: ORIGIN,
            },
            event(n, expiresAtMs),
        ),
    );
    const [row] = await db.database.sql<
        { id: string }[]
    >`select id from credentials where event_id = ${event(n).eventId}`;
    ids[name] = row?.id ?? "";
    return ids[name] ?? "";
}

beforeAll(async () => {
    db = await createMigratedTestDatabase(9);
    const { sql } = db.database;
    await sql`insert into users (id, email, email_verified_at) values (${HOLDER}, 'h@example.com', now())`;
    await sql`insert into users (id, email, email_verified_at, platform_role) values (${ADMIN}, 'a@example.com', now(), 'admin')`;
    const [o] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'pv-uni', 'Uni') returning id`;
    org = o?.id ?? "";
    await worker(
        (tx) =>
            tx`select register_signing_key('dev-pv-1', 'ES256', ${tx.json(signer.publicJwk())}, 'development', ${new Date(NOW)})`,
    );
    await issue("good", 1);
    await issue("hidden", 2);
    await issue("soon", 3, NOW + 60_000);
    await issue("revoked", 4);
    await sql`update credentials set visibility = 'public' where event_id in (select event_id from credentials where kind = 'contest_rank') and id <> ${ids["hidden"] ?? ""}`;
    await inRole(
        db.database,
        "aura_app",
        { actorKind: "user", userId: ADMIN, orgIds: [] },
        (tx) =>
            tx`select revoke_credential(${ids["revoked"] ?? ""}, 'wrong rank', ${new Date(NOW)})`,
    );
    await publish();
});
afterAll(async () => {
    await db.drop();
});

describe("what a verifier is told", () => {
    it("says valid, with what the signature covers, for a public credential", async () => {
        const result = await verify(ids["good"] ?? "");
        expect(result).toMatchObject({
            outcome: "valid",
            status_known: true,
            environment: "development",
            assurance_level: 0,
            name: "Contest 1",
        });
        expect(result.jwt?.split(".")).toHaveLength(3);
        expect(result.expires_at).toBeUndefined();
    });

    it("says expired just after the expiry and revoked over anything else", async () => {
        expect((await verify(ids["soon"] ?? "", NOW + 59_999)).outcome).toBe("valid");
        expect((await verify(ids["soon"] ?? "", NOW + 60_000)).outcome).toBe("expired");
        expect(await verify(ids["revoked"] ?? "")).toMatchObject({
            outcome: "revoked",
            status_known: true,
        });
    });

    it("cannot tell a private credential from one that does not exist", async () => {
        const missing = await verify(makeUuidV7(NOW, systemRng.nextBytes(10)));
        const hidden = await verify(ids["hidden"] ?? "");
        expect(hidden).toEqual({ ...missing, id: `crd_${ids["hidden"]}` });
        expect(missing).toEqual({
            id: expect.any(String),
            outcome: "unknown",
            status_known: false,
        });
    });
});

describe("damaged or missing files", () => {
    it("refuses an edited credential and one filed under another credential's name", async () => {
        const key = credentialKey(ids["good"] ?? "");
        const original = text(key);
        const [h, p, s] = original.split(".");
        const payload = JSON.parse(Buffer.from(p ?? "", "base64url").toString());
        payload.aura_assurance = 3;
        storage.write(
            key,
            new TextEncoder().encode(
                `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`,
            ),
        );
        expect(await verify(ids["good"] ?? "")).toMatchObject({
            outcome: "invalid",
            reason: "signature does not match",
        });
        storage.write(key, new TextEncoder().encode(text(credentialKey(ids["soon"] ?? ""))));
        expect(await verify(ids["good"] ?? "")).toMatchObject({
            outcome: "invalid",
            reason: "this file belongs to another credential",
        });
        storage.write(key, new TextEncoder().encode(original));
        expect((await verify(ids["good"] ?? "")).outcome).toBe("valid");
    });

    it("says the status is not known, never that it is fine, when the list is missing, edited or unsigned", async () => {
        const key = statusKey(0);
        const original = text(key);
        for (const damaged of [null, `${original.slice(0, -4)}AAAA`, "not a jwt", ""]) {
            if (damaged === null) await storage.remove(key);
            else storage.write(key, new TextEncoder().encode(damaged));
            expect(await verify(ids["good"] ?? ""), String(damaged).slice(0, 10)).toMatchObject({
                outcome: "valid",
                status_known: false,
            });
            expect(await verify(ids["revoked"] ?? "")).toMatchObject({
                outcome: "valid",
                status_known: false,
            }); // cannot be shown revoked without the list
        }
        storage.write(key, new TextEncoder().encode(original));
        expect((await verify(ids["revoked"] ?? "")).outcome).toBe("revoked");
    });

    it("cannot verify without the issuer's keys, and refuses a credential whose key was revoked", async () => {
        const original = text(JWKS_KEY);
        await storage.remove(JWKS_KEY);
        expect(await verify(ids["good"] ?? "")).toMatchObject({
            outcome: "unknown",
            reason: expect.stringContaining("keys"),
        });
        storage.write(JWKS_KEY, new TextEncoder().encode('{"keys":[]}'));
        expect((await verify(ids["good"] ?? "")).outcome).toBe("invalid"); // the key was taken out (revoked)
        storage.write(JWKS_KEY, new TextEncoder().encode(original));
        expect((await verify(ids["good"] ?? "")).outcome).toBe("valid");
    });
});

describe("visibility", () => {
    it("stops answering for a credential its holder makes private, once published", async () => {
        await db.database
            .sql`update credentials set visibility = 'private' where id = ${ids["good"] ?? ""}`;
        expect(await publish()).toContain(`-${credentialKey(ids["good"] ?? "")}`);
        expect((await verify(ids["good"] ?? "")).outcome).toBe("unknown");
        await db.database
            .sql`update credentials set visibility = 'public' where id = ${ids["good"] ?? ""}`;
        await publish();
        expect((await verify(ids["good"] ?? "")).outcome).toBe("valid");
    });
});
