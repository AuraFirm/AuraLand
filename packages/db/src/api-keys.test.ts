// Goal: API keys store only a hash that the application role can never read; only owners and admins
// of the organization see, create or revoke its keys; revocation is permanent; an organization holds
// at most 20 live keys (also under concurrency); a key-authenticated request reads only its own
// organization; verify_org works only for platform administrators; step-up challenges belong to a person.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const U = (n: number) => `018f0000-0000-7000-8000-00000000000${n}`;
const OWNER = U(1);
const ADMIN = U(2);
const MEMBER = U(3);
const PLATFORM = U(5);
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const asKey = (orgId: string): RequestContext => ({
    actorKind: "api_key",
    userId: null,
    orgIds: [orgId],
});
const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

let db: TestDatabase;
let team = "";
let other = "";
beforeAll(async () => {
    db = await createMigratedTestDatabase(10);
    const { sql } = db.database;
    for (const n of [1, 2, 3, 5]) {
        await sql`insert into users (id, email) values (${U(n)}, ${`user${n}@example.com`})`;
    }
    await sql`update users set platform_role = 'admin' where id = ${PLATFORM}`;
    [team, other] = await Promise.all([newOrg("team-keys"), newOrg("other-keys")]);
    await sql`insert into memberships (org_id, user_id, role) values (${team}, ${OWNER}, 'owner'), (${team}, ${ADMIN}, 'admin'), (${team}, ${MEMBER}, 'member'), (${other}, ${PLATFORM}, 'owner')`;
});
afterAll(async () => {
    await db.drop();
});

async function newOrg(slug: string): Promise<string> {
    const [row] = await db.database.sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', ${slug}, 'x') returning id`;
    return row?.id ?? "";
}

let keyCounter = 0;
const prefix = () => `k${String(++keyCounter).padStart(11, "0")}`;
const createKey = (
    userId: string,
    org: string,
    overrides: { scopes?: string[]; days?: number; name?: string } = {},
) =>
    inRole(
        db.database,
        "aura_app",
        as(userId),
        (tx) =>
            tx<
                { id: string }[]
            >`insert into api_keys (org_id, name, prefix, secret_hash, scopes, created_by, expires_at)
           values (${org}, ${overrides.name ?? "ci"}, ${prefix()}, ${randomBytes(32)}, ${overrides.scopes ?? ["org:read"]},
                   ${userId}, now() + make_interval(days => ${overrides.days ?? 90})) returning id`,
    );

describe("api_keys rules", () => {
    it("accepts a valid key and refuses malformed ones", async () => {
        expect((await createKey(OWNER, team)).length).toBe(1);
        await fails(createKey(OWNER, team, { scopes: [] }), /api_keys_scopes/);
        await fails(createKey(OWNER, team, { scopes: ["org:write"] }), /api_keys_scopes/);
        await fails(createKey(OWNER, team, { days: 400 }), /api_keys_expiry/);
        await fails(createKey(OWNER, team, { name: "" }), /api_keys_name/);
    });

    it("caps live keys at 20 per organization, also with simultaneous creations", async () => {
        const org = await newOrg("cap-keys");
        await db.database
            .sql`insert into memberships (org_id, user_id, role) values (${org}, ${OWNER}, 'owner')`;
        const results = await Promise.allSettled(
            Array.from({ length: 25 }, () => createKey(OWNER, org)),
        );
        expect(results.filter((r) => r.status === "fulfilled").length).toBe(20);
    });

    it("keeps a revoked key revoked", async () => {
        const [row] = await createKey(ADMIN, team);
        const id = row?.id ?? "";
        const revoke = (value: string) =>
            inRole(
                db.database,
                "aura_app",
                as(ADMIN),
                (tx) => tx`update api_keys set revoked_at = ${value}::timestamptz where id = ${id}`,
            );
        await revoke("2026-01-01T00:00:00Z");
        await fails(revoke("2026-02-01T00:00:00Z"), /stays revoked/);
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(ADMIN),
                (tx) => tx`update api_keys set revoked_at = null where id = ${id}`,
            ),
            /stays revoked/,
        );
    });
});

describe("who may touch api_keys", () => {
    it("shows keys to owners and admins of the organization only, and never the hash", async () => {
        const list = (user: string) =>
            inRole(
                db.database,
                "aura_app",
                as(user),
                (tx) => tx`select id, name from api_keys where org_id = ${team}`,
            );
        expect((await list(OWNER)).length).toBeGreaterThan(0);
        expect((await list(ADMIN)).length).toBeGreaterThan(0);
        expect((await list(MEMBER)).length).toBe(0);
        expect((await list(PLATFORM)).length).toBe(0);
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(OWNER),
                (tx) => tx`select secret_hash from api_keys`,
            ),
            /permission denied/,
        );
        await fails(
            inRole(db.database, "aura_app", as(OWNER), (tx) => tx`select * from api_keys`),
            /permission denied/,
        );
    });

    it("lets only owners and admins create keys, and only as themselves", async () => {
        await fails(createKey(MEMBER, team), /row-level security/);
        await fails(createKey(PLATFORM, team), /row-level security/);
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(OWNER),
                (tx) =>
                    tx`insert into api_keys (org_id, name, prefix, secret_hash, scopes, created_by, expires_at)
                   values (${team}, 'x', ${prefix()}, ${randomBytes(32)}, ${["org:read"]}, ${ADMIN}, now() + interval '1 day')`,
            ),
            /row-level security/,
        );
    });
});

describe("who may change api_keys", () => {
    it("lets members and strangers neither revoke keys nor change anything else", async () => {
        const revoke = (user: string) =>
            inRole(
                db.database,
                "aura_app",
                as(user),
                (tx) =>
                    tx`update api_keys set revoked_at = now() where org_id = ${team} returning id`,
            );
        expect((await revoke(MEMBER)).length).toBe(0);
        expect((await revoke(PLATFORM)).length).toBe(0);
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(OWNER),
                (tx) => tx`update api_keys set scopes = ${["org:read"]} where org_id = ${team}`,
            ),
            /permission denied/,
        );
    });

    it("lets the identity role find a key by prefix and record its use, but not change its secret", async () => {
        const [row] = await db.database.sql<
            { prefix: string }[]
        >`select prefix from api_keys where org_id = ${team} limit 1`;
        const ctx: RequestContext = { actorKind: "anonymous", userId: null, orgIds: [] };
        const found = await inRole(
            db.database,
            "aura_auth",
            ctx,
            (tx) => tx`select secret_hash from api_keys where prefix = ${row?.prefix ?? ""}`,
        );
        expect(found.length).toBe(1);
        await inRole(
            db.database,
            "aura_auth",
            ctx,
            (tx) =>
                tx`update api_keys set last_used_at = now() where prefix = ${row?.prefix ?? ""}`,
        );
        await fails(
            inRole(
                db.database,
                "aura_auth",
                ctx,
                (tx) =>
                    tx`update api_keys set secret_hash = ${randomBytes(32)} where prefix = ${row?.prefix ?? ""}`,
            ),
            /permission denied/,
        );
    });
});

describe("a request authenticated by an API key", () => {
    it("reads its own organization and no other", async () => {
        const mine = await inRole(
            db.database,
            "aura_app",
            asKey(team),
            (tx) => tx`select slug from orgs`,
        );
        expect(mine.map((r) => r["slug"])).toEqual(["team-keys"]);
        const none = await inRole(
            db.database,
            "aura_app",
            asKey(team),
            (tx) => tx`select slug from orgs where id = ${other}`,
        );
        expect(none.length).toBe(0);
        const keys = await inRole(
            db.database,
            "aura_app",
            asKey(team),
            (tx) => tx`select id from api_keys`,
        );
        expect(keys.length).toBe(0);
    });

    it("cannot write anything", async () => {
        const renamed = await inRole(
            db.database,
            "aura_app",
            asKey(team),
            (tx) => tx`update orgs set name = 'hacked' returning id`,
        );
        expect(renamed.length).toBe(0);
    });
});

describe("verify_org", () => {
    const verify = (user: string, org: string) =>
        inRole(db.database, "aura_app", as(user), (tx) => tx`select verify_org(${org})`);

    it("lets a platform administrator verify any organization, and nobody else", async () => {
        await fails(verify(OWNER, team), /only a platform administrator/);
        await fails(verify(MEMBER, team), /only a platform administrator/);
        await verify(PLATFORM, team);
        const [row] = await db.database.sql<
            { verification_state: string; verified_at: Date | null }[]
        >`select verification_state, verified_at from orgs where id = ${team}`;
        expect(row?.verification_state).toBe("verified");
        expect(row?.verified_at).not.toBeNull();
        await fails(
            verify(PLATFORM, "018f0000-0000-7000-8000-0000000000ff"),
            /no such organization/,
        );
        await fails(
            inRole(
                db.database,
                "aura_app",
                { actorKind: "anonymous", userId: null, orgIds: [] },
                (tx) => tx`select verify_org(${team})`,
            ),
            /only a platform administrator/,
        );
    });
});

describe("step-up challenges", () => {
    const challenge = (purpose: string, userId: string | null, n: number) =>
        db.database
            .sql`insert into webauthn_challenges (challenge, purpose, user_id, created_at, expires_at)
            values (${Buffer.alloc(32, n).toString("base64url")}, ${purpose}, ${userId}, now(), now() + interval '5 minutes')`;

    it("belong to a person, like registration challenges", async () => {
        await challenge("step_up", OWNER, 1);
        await fails(challenge("step_up", null, 2), /webauthn_challenges_owner/);
        await fails(challenge("login", OWNER, 3), /webauthn_challenges_owner/);
        await fails(challenge("elevate", null, 4), /webauthn_challenges_purpose/);
    });
});
