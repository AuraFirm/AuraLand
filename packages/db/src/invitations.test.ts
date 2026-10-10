// Goal: invitations hold only a hash of their secret, are visible and creatable only by the right
// roles (owners invite admins, admins invite members), end exactly once (accepted or revoked), cannot
// be made for personal spaces, and are capped; personal spaces never get a second member.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const U = (n: number) => `018f0000-0000-7000-8000-00000000000${n}`;
const OWNER = U(1);
const ADMIN = U(2);
const MEMBER = U(3);
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const identity: RequestContext = { actorKind: "anonymous", userId: null, orgIds: [] };
const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

let db: TestDatabase;
let team = "";
let personal = "";
beforeAll(async () => {
    db = await createMigratedTestDatabase(10);
    const { sql } = db.database;
    for (const n of [1, 2, 3])
        await sql`insert into users (id, email) values (${U(n)}, ${`user${n}@example.com`})`;
    [team, personal] = await Promise.all([
        newOrg("company", "invite-team"),
        newOrg("personal", "p-0a0a0a0a0a"),
    ]);
    await sql`insert into memberships (org_id, user_id, role) values (${team}, ${OWNER}, 'owner'), (${team}, ${ADMIN}, 'admin'), (${team}, ${MEMBER}, 'member'), (${personal}, ${OWNER}, 'owner')`;
});
afterAll(async () => {
    await db.drop();
});

async function newOrg(kind: string, slug: string): Promise<string> {
    const [row] = await db.database.sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values (${kind}, ${slug}, 'x') returning id`;
    return row?.id ?? "";
}

let counter = 0;
const invite = (
    userId: string,
    org: string,
    role: string,
    email = `invitee${++counter}@example.com`,
) =>
    inRole(
        db.database,
        "aura_app",
        as(userId),
        (tx) =>
            tx<
                { id: string }[]
            >`insert into org_invitations (org_id, email, role, token_hash, invited_by, created_at, expires_at)
           values (${org}, ${email}, ${role}, ${randomBytes(32)}, ${userId}, now(), now() + interval '7 days') returning id`,
    );

describe("who may create invitations", () => {
    it("lets owners invite admins and members, admins invite members, and nobody else invite anyone", async () => {
        expect((await invite(OWNER, team, "admin")).length).toBe(1);
        expect((await invite(OWNER, team, "member")).length).toBe(1);
        expect((await invite(ADMIN, team, "member")).length).toBe(1);
        await fails(invite(ADMIN, team, "admin"), /row-level security/);
        await fails(invite(MEMBER, team, "member"), /row-level security/);
        await fails(invite(OWNER, team, "owner"), /row-level security/);
    });

    it("refuses invitations for personal spaces and as someone else", async () => {
        await fails(invite(OWNER, personal, "member"), /personal space cannot invite/);
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(OWNER),
                (tx) =>
                    tx`insert into org_invitations (org_id, email, role, token_hash, invited_by, created_at, expires_at)
                   values (${team}, 'x@example.com', 'member', ${randomBytes(32)}, ${ADMIN}, now(), now() + interval '1 day')`,
            ),
            /row-level security/,
        );
    });

    it("refuses malformed rows", async () => {
        const insert = (email: string, days: number) =>
            db.database
                .sql`insert into org_invitations (org_id, email, role, token_hash, invited_by, created_at, expires_at)
               values (${team}, ${email}, 'member', ${randomBytes(32)}, ${OWNER}, now(), now() + make_interval(days => ${days}))`;
        await fails(insert("Upper@Example.com", 1), /org_invitations_email/);
        await fails(insert("fine@example.com", 9), /org_invitations_expiry/);
        await fails(insert("fine@example.com", 0), /org_invitations_expiry/);
        await fails(
            db.database
                .sql`insert into org_invitations (org_id, email, role, token_hash, invited_by, created_at, expires_at)
               values (${team}, 'fine@example.com', 'owner', ${randomBytes(32)}, ${OWNER}, now(), now() + interval '1 day')`,
            /org_invitations_role/,
        );
    });
});

describe("who may see and end invitations", () => {
    it("shows pending invitations to owners and admins only, never the hash", async () => {
        const list = (user: string) =>
            inRole(
                db.database,
                "aura_app",
                as(user),
                (tx) => tx`select id, email from org_invitations where org_id = ${team}`,
            );
        expect((await list(OWNER)).length).toBeGreaterThan(0);
        expect((await list(ADMIN)).length).toBeGreaterThan(0);
        expect((await list(MEMBER)).length).toBe(0);
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(OWNER),
                (tx) => tx`select token_hash from org_invitations`,
            ),
            /permission denied/,
        );
    });

    it("ends an invitation once: revoked or accepted, then frozen", async () => {
        const [one] = await invite(OWNER, team, "member");
        const [two] = await invite(OWNER, team, "member");
        const revoke = (user: string, id: string) =>
            inRole(
                db.database,
                "aura_app",
                as(user),
                (tx) =>
                    tx`update org_invitations set revoked_at = now() where id = ${id} returning id`,
            );
        expect((await revoke(MEMBER, one?.id ?? "")).length).toBe(0);
        expect((await revoke(ADMIN, one?.id ?? "")).length).toBe(1);
        await fails(revoke(OWNER, one?.id ?? ""), /does not change/);
        await inRole(
            db.database,
            "aura_auth",
            identity,
            (tx) => tx`update org_invitations set accepted_at = now() where id = ${two?.id ?? ""}`,
        );
        await fails(revoke(OWNER, two?.id ?? ""), /does not change|one_end/);
        await fails(
            inRole(
                db.database,
                "aura_auth",
                identity,
                (tx) =>
                    tx`update org_invitations set accepted_at = null where id = ${two?.id ?? ""}`,
            ),
            /does not change/,
        );
    });
});

describe("limits", () => {
    it("allows 100 pending invitations per organization, also simultaneously", async () => {
        const org = await newOrg("company", "capped-invites");
        await db.database
            .sql`insert into memberships (org_id, user_id, role) values (${org}, ${OWNER}, 'owner')`;
        const results = await Promise.allSettled(
            Array.from({ length: 110 }, () => invite(OWNER, org, "member")),
        );
        expect(results.filter((r) => r.status === "fulfilled").length).toBe(100);
    });

    it("keeps a personal space to its owner", async () => {
        await fails(
            db.database
                .sql`insert into memberships (org_id, user_id, role) values (${personal}, ${ADMIN}, 'member')`,
            /only its owner/,
        );
    });

    it("caps an organization at 5000 members", async () => {
        const { sql } = db.database;
        const org = await newOrg("company", "huge-org");
        await sql`insert into users (email) select 'bulk' || g || '@example.com' from generate_series(1, 5000) g`;
        await sql`insert into memberships (org_id, user_id, role) select ${org}, id, 'member' from (select id from users where email like 'bulk%' order by email limit 4999) u`;
        await sql`insert into memberships (org_id, user_id, role) select ${org}, id, 'owner' from (select id from users where email = 'user1@example.com') u`;
        await fails(
            sql`insert into memberships (org_id, user_id, role) select ${org}, id, 'member' from users where email = 'bulk5000@example.com'`,
            /at most 5000 members/,
        );
    });
});
