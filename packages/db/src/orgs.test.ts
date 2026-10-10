// Goal: organizations are visible only to their members, roles limit who may change what, an
// organization never loses its last owner (also under concurrency), a person cannot join more than
// 20, and an organization can only be created through the one function that makes the creator its owner.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const U = (n: number) => `018f0000-0000-7000-8000-00000000000${n}`;
const OWNER = U(1);
const ADMIN = U(2);
const MEMBER = U(3);
const STRANGER = U(4);
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const anonymous: RequestContext = { actorKind: "anonymous", userId: null, orgIds: [] };
const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

let db: TestDatabase;
let team = "";
beforeAll(async () => {
    db = await createMigratedTestDatabase(10);
    const { sql } = db.database;
    for (const [n, handle] of [
        [1, "owner"],
        [2, "admin"],
        [3, "member"],
        [4, "stranger"],
    ] as const) {
        await sql`insert into users (id, email) values (${U(n)}, ${`${handle}@example.com`})`;
        await sql`insert into profiles (user_id, handle, display_name) values (${U(n)}, ${handle}, ${handle})`;
    }
    team = await createOrg(OWNER, "team-one");
    await sql`insert into memberships (org_id, user_id, role) values (${team}, ${ADMIN}, 'admin'), (${team}, ${MEMBER}, 'member')`;
});
afterAll(async () => {
    await db.drop();
});

async function createOrg(userId: string, slug: string, kind = "company"): Promise<string> {
    const rows = await inRole(
        db.database,
        "aura_app",
        as(userId),
        (tx) => tx<{ id: string }[]>`select create_org(${kind}, ${slug}, 'Team', 'eu') as id`,
    );
    return rows[0]?.id ?? "";
}

describe("organization rules", () => {
    it("accepts a team and refuses malformed slugs, names and regions", async () => {
        const { sql } = db.database;
        await fails(
            sql`insert into orgs (kind, slug, name) values ('company', 'Bad Slug', 'x')`,
            /orgs_slug_format/,
        );
        await fails(
            sql`insert into orgs (kind, slug, name) values ('company', 'ab', 'x')`,
            /orgs_slug_format/,
        );
        await fails(
            sql`insert into orgs (kind, slug, name) values ('company', 'fine-slug', '')`,
            /orgs_name/,
        );
        await fails(
            sql`insert into orgs (kind, slug, name, data_region) values ('company', 'fine-slug', 'x', 'mars')`,
            /orgs_data_region/,
        );
        await fails(
            sql`insert into orgs (kind, slug, name) values ('dungeon', 'fine-slug', 'x')`,
            /orgs_kind/,
        );
    });

    it("reserves the personal-space slug shape for personal spaces only", async () => {
        const { sql } = db.database;
        await fails(
            sql`insert into orgs (kind, slug, name) values ('company', 'p-0123456789', 'x')`,
            /orgs_personal_slug/,
        );
        await fails(
            sql`insert into orgs (kind, slug, name) values ('personal', 'my-space', 'x')`,
            /orgs_personal_slug/,
        );
        await sql`insert into orgs (kind, slug, name) values ('personal', 'p-0123456789', 'Personal space')`;
    });

    it("keeps verification state and time together", async () => {
        const { sql } = db.database;
        await fails(
            sql`update orgs set verification_state = 'verified' where id = ${team}`,
            /orgs_verified_pair/,
        );
        await fails(
            sql`update orgs set verified_at = now() where id = ${team}`,
            /orgs_verified_pair/,
        );
    });
});

describe("create_org", () => {
    it("makes the caller the first owner, atomically", async () => {
        const id = await createOrg(STRANGER, "strangers-club", "community");
        const [row] = await db.database.sql<
            { role: string }[]
        >`select role from memberships where org_id = ${id} and user_id = ${STRANGER}`;
        expect(row?.role).toBe("owner");
    });

    it("refuses anonymous callers, personal and platform kinds, and duplicate slugs", async () => {
        await fails(
            inRole(
                db.database,
                "aura_app",
                anonymous,
                (tx) => tx`select create_org('company', 'anon-org', 'x', 'eu')`,
            ),
            /sign in/,
        );
        await fails(createOrg(OWNER, "fake-personal", "personal"), /cannot be created here/);
        await fails(createOrg(OWNER, "fake-platform", "platform"), /cannot be created here/);
        await fails(createOrg(OWNER, "team-one"), /duplicate key/);
    });

    it("is the only way for the application role to make organizations or memberships", async () => {
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(OWNER),
                (tx) => tx`insert into orgs (kind, slug, name) values ('company', 'sneaky', 'x')`,
            ),
            /permission denied/,
        );
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(STRANGER),
                (tx) =>
                    tx`insert into memberships (org_id, user_id, role) values (${team}, ${STRANGER}, 'owner')`,
            ),
            /permission denied/,
        );
    });
});

describe("visibility and editing", () => {
    it("shows members their organization and strangers nothing", async () => {
        for (const user of [OWNER, ADMIN, MEMBER]) {
            const rows = await inRole(
                db.database,
                "aura_app",
                as(user),
                (tx) => tx`select slug from orgs where id = ${team}`,
            );
            expect(rows.length, user).toBe(1);
        }
        const none = await inRole(
            db.database,
            "aura_app",
            as(STRANGER),
            (tx) => tx`select slug from orgs where id = ${team}`,
        );
        expect(none.length).toBe(0);
        const memberships = await inRole(
            db.database,
            "aura_app",
            as(STRANGER),
            (tx) => tx`select * from memberships where org_id = ${team}`,
        );
        expect(memberships.length).toBe(0);
    });

    it("lets owners and admins rename, not members, and never change the slug or verification", async () => {
        const rename = (user: string) =>
            inRole(
                db.database,
                "aura_app",
                as(user),
                (tx) => tx`update orgs set name = 'Renamed' where id = ${team} returning id`,
            );
        expect((await rename(ADMIN)).length).toBe(1);
        expect((await rename(OWNER)).length).toBe(1);
        expect((await rename(MEMBER)).length).toBe(0);
        expect((await rename(STRANGER)).length).toBe(0);
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(OWNER),
                (tx) => tx`update orgs set slug = 'taken-over' where id = ${team}`,
            ),
            /permission denied/,
        );
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(OWNER),
                (tx) => tx`update orgs set verification_state = 'verified' where id = ${team}`,
            ),
            /permission denied/,
        );
    });
});

describe("profiles of coworkers", () => {
    it("shows coworkers' profiles to each other but not to strangers", async () => {
        const seen = (user: string, target: string) =>
            inRole(
                db.database,
                "aura_app",
                as(user),
                (tx) => tx`select handle from profiles where user_id = ${target}`,
            );
        expect((await seen(MEMBER, OWNER)).length).toBe(1);
        expect((await seen(STRANGER, OWNER)).length).toBe(0);
    });
});

const remove = (actor: string, target: string, org: string) =>
    inRole(
        db.database,
        "aura_app",
        as(actor),
        (tx) =>
            tx`delete from memberships where org_id = ${org} and user_id = ${target} returning user_id`,
    );
const setRole = (actor: string, target: string, role: string, org: string) =>
    inRole(
        db.database,
        "aura_app",
        as(actor),
        (tx) =>
            tx`update memberships set role = ${role} where org_id = ${org} and user_id = ${target} returning user_id`,
    );

describe("membership changes by role", () => {
    it("lets only owners change roles", async () => {
        expect((await setRole(ADMIN, MEMBER, "admin", team)).length).toBe(0);
        expect((await setRole(MEMBER, MEMBER, "owner", team)).length).toBe(0);
        expect((await setRole(OWNER, MEMBER, "admin", team)).length).toBe(1);
        expect((await setRole(OWNER, MEMBER, "member", team)).length).toBe(1);
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(OWNER),
                (tx) => tx`update memberships set user_id = ${STRANGER} where org_id = ${team}`,
            ),
            /permission denied/,
        );
    });

    it("lets admins remove plain members but not admins or owners, and members only themselves", async () => {
        const sql = db.database.sql;
        await sql`insert into memberships (org_id, user_id, role) values (${team}, ${STRANGER}, 'member')`;
        expect((await remove(ADMIN, OWNER, team)).length).toBe(0);
        expect((await remove(MEMBER, ADMIN, team)).length).toBe(0);
        expect((await remove(ADMIN, STRANGER, team)).length).toBe(1);
        await sql`insert into memberships (org_id, user_id, role) values (${team}, ${STRANGER}, 'admin')`;
        expect((await remove(ADMIN, STRANGER, team)).length).toBe(0);
        expect((await remove(STRANGER, STRANGER, team)).length).toBe(1);
    });
});

describe("membership changes by role, last owner", () => {
    it("never leaves an organization without an owner", async () => {
        const solo = await createOrg(ADMIN, "solo-org");
        await fails(remove(ADMIN, ADMIN, solo), /at least one owner/);
        await fails(setRole(ADMIN, ADMIN, "admin", solo), /at least one owner/);
        await db.database
            .sql`insert into memberships (org_id, user_id, role) values (${solo}, ${MEMBER}, 'owner')`;
        expect((await remove(ADMIN, ADMIN, solo)).length).toBe(1);
        await fails(remove(MEMBER, MEMBER, solo), /at least one owner/);
    });

    it("lets exactly one of two simultaneous owner departures succeed", async () => {
        for (let round = 0; round < 5; round++) {
            const shared = await createOrg(OWNER, `duo-${round}-org`);
            await db.database
                .sql`insert into memberships (org_id, user_id, role) values (${shared}, ${ADMIN}, 'owner')`;
            const results = await Promise.allSettled([
                remove(OWNER, OWNER, shared),
                remove(ADMIN, ADMIN, shared),
            ]);
            expect(results.filter((r) => r.status === "fulfilled").length, `round ${round}`).toBe(
                1,
            );
            const [row] = await db.database.sql<
                { n: string }[]
            >`select count(*) n from memberships where org_id = ${shared} and role = 'owner'`;
            expect(row?.n).toBe("1");
        }
    });

    it("allows an organization to be deleted along with its last owner", async () => {
        const gone = await createOrg(STRANGER, "doomed-org");
        await db.database.sql`delete from orgs where id = ${gone}`;
        const [row] = await db.database.sql<
            { n: string }[]
        >`select count(*) n from memberships where org_id = ${gone}`;
        expect(row?.n).toBe("0");
    });
});

describe("membership cap", () => {
    it("allows 20 organizations per person and refuses the 21st, even simultaneously", async () => {
        const { sql } = db.database;
        const [row] = await sql<
            { n: string }[]
        >`select count(*) n from memberships where user_id = ${MEMBER}`;
        const have = Number(row?.n);
        const ids = await Promise.all(
            Array.from({ length: 25 - have }, (_, i) =>
                sql<
                    { id: string }[]
                >`insert into orgs (kind, slug, name) values ('company', ${`cap-${i}-org`}, 'x') returning id`.then(
                    (r) => r[0]?.id ?? "",
                ),
            ),
        );
        const results = await Promise.allSettled(
            ids.map(
                (id) =>
                    sql`insert into memberships (org_id, user_id, role) values (${id}, ${MEMBER}, 'owner')`,
            ),
        );
        expect(results.filter((r) => r.status === "fulfilled").length).toBe(20 - have);
        const [after] = await sql<
            { n: string }[]
        >`select count(*) n from memberships where user_id = ${MEMBER}`;
        expect(after?.n).toBe("20");
    });
});
