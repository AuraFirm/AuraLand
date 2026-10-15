// Goal: issuing writes one verifiable credential per (person, kind, event) and never changes it afterwards. Method:
// the real signer and database; issue twice and get one row; read the stored JWT back with the published keys;
// separate events get separate places in the revocation list; the holder reads only their own row; what was
// signed cannot be edited and a credential cannot be deleted.

import { createMigratedTestDatabase, inRole, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemRng } from "../../platform/rng.ts";
import { createDevelopmentSigner } from "../../platform/signer.ts";
import { issuerDid } from "./documents.ts";
import { type Event, issueOnce } from "./issuing.ts";
import { verifyCredentialJwt } from "./verify.ts";

const ADA = "018f0000-0000-7000-8000-000000000b01";
const BEN = "018f0000-0000-7000-8000-000000000b02";
const ORIGIN = "https://passport.example";
const NOW = Date.UTC(2026, 10, 1, 12);
const signer = createDevelopmentSigner({ keyId: "dev-issue-1", appEnvironment: "test" });
let db: TestDatabase;
let org = "";

const worker = <T>(work: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<T>) =>
    inRole(db.database, "aura_worker", { actorKind: "worker", userId: null, orgIds: [] }, work);
const context = {
    clock: { nowUnixMs: () => NOW },
    rng: systemRng,
    signer,
    issuerDid: issuerDid(ORIGIN),
    issuerName: "AuraLand (development)",
    publicOrigin: ORIGIN,
};
const event = (user: string, eventId: string): Event => ({
    subjectUserId: user,
    issuerOrgId: org,
    eventId,
    assurance: 0,
    expiresAtMs: null,
    claim: {
        kind: "contest_rank",
        event_title: "Weekly",
        host_name: "Uni",
        rank: 2,
        participants: 40,
        solved: 3,
        finalized_at: new Date(NOW).toISOString(),
    },
});
const E1 = "018f0000-0000-7000-8000-00000000e001";
const E2 = "018f0000-0000-7000-8000-00000000e002";

beforeAll(async () => {
    db = await createMigratedTestDatabase(9);
    const { sql } = db.database;
    await sql`insert into users (id, email, email_verified_at) values (${ADA}, 'ada@example.com', now()), (${BEN}, 'ben@example.com', now())`;
    const [o] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'issue-uni', 'Uni') returning id`;
    org = o?.id ?? "";
    await worker(
        (tx) =>
            tx`select register_signing_key('dev-issue-1', 'ES256', ${tx.json(signer.publicJwk())}, 'development', ${new Date(NOW)})`,
    );
});
afterAll(async () => {
    await db.drop();
});

describe("issueOnce", () => {
    it("issues one credential per person and event, and says so on a repeat", async () => {
        expect(await worker((tx) => issueOnce(tx, context, event(ADA, E1)))).toBe("issued");
        expect(await worker((tx) => issueOnce(tx, context, event(ADA, E1)))).toBe("exists");
        expect(await worker((tx) => issueOnce(tx, context, event(ADA, E2)))).toBe("issued");
        expect(await worker((tx) => issueOnce(tx, context, event(BEN, E1)))).toBe("issued");
        const rows = await db.database.sql<
            { status_list: number; status_index: number }[]
        >`select status_list, status_index from credentials`;
        expect(rows).toHaveLength(3);
        expect(new Set(rows.map((r) => `${r.status_list}:${r.status_index}`)).size).toBe(3); // places never shared
    });

    it("stores a JWT that verifies with the published keys and names its own place in the list", async () => {
        const [row] = await db.database.sql<
            { vc_jwt: string; status_list: number; status_index: number; kid: string }[]
        >`
            select vc_jwt, status_list, status_index, kid from credentials where subject_user_id = ${ADA} and event_id = ${E1}`;
        const keys = [
            {
                kid: signer.keyId,
                alg: signer.alg,
                status: "active" as const,
                jwk: signer.publicJwk(),
            },
        ];
        const result = await verifyCredentialJwt(row?.vc_jwt ?? "", keys, NOW + 1000);
        expect(result.outcome).toBe("valid");
        if (result.outcome === "invalid") throw new Error("expected valid");
        expect(result.status.index).toBe(row?.status_index);
        expect(result.status.listUrl).toBe(`${ORIGIN}/api/public/status-lists/${row?.status_list}`);
        expect(result.kid).toBe(row?.kid);
    });
});

describe("who reads and what changes", () => {
    it("shows a holder only their own credentials", async () => {
        const asUser = (id: string) =>
            inRole(
                db.database,
                "aura_app",
                { actorKind: "user", userId: id, orgIds: [] },
                (tx) => tx`select subject_user_id from credentials`,
            );
        expect((await asUser(ADA)).map((r) => r["subject_user_id"])).toEqual([ADA, ADA]);
        expect((await asUser(BEN)).length).toBe(1);
        const anonymous = await inRole(
            db.database,
            "aura_app",
            { actorKind: "anonymous", userId: null, orgIds: [] },
            (tx) => tx`select id from credentials`,
        );
        expect(anonymous).toEqual([]);
    });

    it("never edits what was signed, undoes a revocation, or deletes a credential", async () => {
        const { sql } = db.database;
        await expect(sql`update credentials set vc_jwt = repeat('x', 200)`).rejects.toThrow(
            /never changes/,
        );
        await expect(sql`update credentials set claim = '{}'::jsonb`).rejects.toThrow(
            /never changes/,
        );
        await expect(sql`delete from credentials`).rejects.toThrow(/kept/);
        await sql`update credentials set visibility = 'public' where subject_user_id = ${BEN}`; // the holder's choice may change
        await sql`update credentials set revoked_at = now(), revoke_reason = 'test' where subject_user_id = ${BEN}`;
        await expect(
            sql`update credentials set revoked_at = null where subject_user_id = ${BEN}`,
        ).rejects.toThrow(/not undone/);
    });
});
