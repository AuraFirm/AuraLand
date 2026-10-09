// Goal: users and profiles enforce their shape in the database and expose each person only to
// themselves (profiles also to the public when marked public), while the identity role can do the
// pre-login work it needs and nothing else.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const A = "018f0000-0000-7000-8000-0000000000aa";
const B = "018f0000-0000-7000-8000-0000000000bb";
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const anonymous: RequestContext = { actorKind: "anonymous", userId: null, orgIds: [] };

let db: TestDatabase;
beforeAll(async () => {
    db = await createMigratedTestDatabase();
    const { sql } = db.database;
    await sql`insert into users (id, email) values (${A}, 'a@example.com'), (${B}, 'b@example.com')`;
    await sql`insert into profiles (user_id, handle, display_name, visibility) values
        (${A}, 'alice', 'Alice', 'public'), (${B}, 'bob', 'Bob', 'unlisted')`;
});
afterAll(async () => {
    await db.drop();
});

const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

describe("users table rules", () => {
    it("requires a lowercase, bounded, unique-ignoring-case email", async () => {
        const { sql } = db.database;
        await fails(
            sql`insert into users (email) values ('Mixed@Example.com')`,
            /users_email_lowercase/,
        );
        await fails(sql`insert into users (email) values ('a@example.com')`, /duplicate key/);
        await fails(
            sql`insert into users (email) values (${`${"a".repeat(250)}@e.co`})`,
            /users_email_length/,
        );
        await fails(sql`insert into users (email) values ('')`, /users_email_length/);
    });

    it("limits status and platform role to known values and defaults to the safest", async () => {
        const { sql } = db.database;
        await fails(sql`update users set status = 'banned' where id = ${A}`, /users_status_check/);
        await fails(
            sql`update users set platform_role = 'root' where id = ${A}`,
            /users_platform_role_check/,
        );
        const [row] = await sql<
            { status: string; platform_role: string }[]
        >`select status, platform_role from users where id = ${A}`;
        expect(row).toEqual({ status: "active", platform_role: "none" });
    });

    it("moves updated_at forward on change", async () => {
        const { sql } = db.database;
        const [before] = await sql<
            { t: Date }[]
        >`select updated_at as t from users where id = ${B}`;
        await sql`select pg_sleep(0.01)`;
        await sql`update users set deletion_requested_at = now() where id = ${B}`;
        const [after] = await sql<{ t: Date }[]>`select updated_at as t from users where id = ${B}`;
        expect((after?.t.getTime() ?? 0) > (before?.t.getTime() ?? 0)).toBe(true);
        await sql`update users set deletion_requested_at = null where id = ${B}`;
    });
});

describe("profiles table rules", () => {
    it("enforces the handle format and uniqueness regardless of case", async () => {
        const { sql } = db.database;
        const add = (handle: string) =>
            sql`insert into profiles (user_id, handle, display_name) values (${A}, ${handle}, 'X')`;
        await fails(add("ab"), /profiles_handle_check/);
        await fails(add("Has-Dash"), /profiles_handle_check/);
        await fails(add("a".repeat(25)), /profiles_handle_check/);
        await fails(add("ALICE"), /duplicate key|profiles_handle_check/);
    });

    it("is removed together with its user", async () => {
        const { sql } = db.database;
        const id = "018f0000-0000-7000-8000-0000000000dd";
        await sql`insert into users (id, email) values (${id}, 'gone@example.com')`;
        await sql`insert into profiles (user_id, handle, display_name) values (${id}, 'gone_user', 'Gone')`;
        await sql`delete from users where id = ${id}`;
        const rows = await sql`select 1 from profiles where user_id = ${id}`;
        expect(rows.length).toBe(0);
    });
});

describe("row-level security as the application", () => {
    it("shows a person only their own user row, and nothing to anonymous visitors", async () => {
        const mine = await inRole(
            db.database,
            "aura_app",
            as(A),
            (tx) => tx<{ email: string }[]>`select email from users`,
        );
        expect(mine.map((r) => r.email)).toEqual(["a@example.com"]);
        const none = await inRole(
            db.database,
            "aura_app",
            anonymous,
            (tx) => tx`select 1 from users`,
        );
        expect(none.length).toBe(0);
    });

    it("lets a person change only the columns they are granted", async () => {
        await inRole(
            db.database,
            "aura_app",
            as(A),
            (tx) => tx`update users set deletion_requested_at = now() where id = ${A}`,
        );
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(A),
                (tx) => tx`update users set platform_role = 'admin' where id = ${A}`,
            ),
            /permission denied/,
        );
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(A),
                (tx) => tx`update users set email = 'x@example.com' where id = ${A}`,
            ),
            /permission denied/,
        );
        const others = await inRole(
            db.database,
            "aura_app",
            as(A),
            (tx) => tx`update users set deletion_requested_at = now() where id = ${B}`,
        );
        expect(others.count).toBe(0);
        await db.database.sql`update users set deletion_requested_at = null where id = ${A}`;
    });
});

describe("row-level security as the application, profiles and writes", () => {
    it("shows public profiles to everyone, others only to their owner", async () => {
        const seenByB = await inRole(
            db.database,
            "aura_app",
            as(B),
            (tx) => tx<{ handle: string }[]>`select handle from profiles order by handle`,
        );
        expect(seenByB.map((r) => r.handle)).toEqual(["alice", "bob"]);
        const seenByA = await inRole(
            db.database,
            "aura_app",
            as(A),
            (tx) => tx<{ handle: string }[]>`select handle from profiles order by handle`,
        );
        expect(seenByA.map((r) => r.handle)).toEqual(["alice"]);
        const visitor = await inRole(
            db.database,
            "aura_app",
            anonymous,
            (tx) => tx<{ handle: string }[]>`select handle from profiles`,
        );
        expect(visitor.map((r) => r.handle)).toEqual(["alice"]);
    });

    it("lets a person edit their own profile and nobody else's", async () => {
        await inRole(
            db.database,
            "aura_app",
            as(A),
            (tx) => tx`update profiles set display_name = 'Alice L' where user_id = ${A}`,
        );
        const others = await inRole(
            db.database,
            "aura_app",
            as(A),
            (tx) => tx`update profiles set display_name = 'Hacked' where user_id = ${B}`,
        );
        expect(others.count).toBe(0);
        const [row] = await db.database.sql<
            { display_name: string }[]
        >`select display_name from profiles where user_id = ${B}`;
        expect(row?.display_name).toBe("Bob");
    });

    it("cannot create users, which only the identity role does", async () => {
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(A),
                (tx) => tx`insert into users (email) values ('new@example.com')`,
            ),
            /permission denied/,
        );
    });
});

describe("the identity role", () => {
    it("finds users by email before anyone is logged in, and creates users and profiles", async () => {
        const found = await inRole(
            db.database,
            "aura_auth",
            anonymous,
            (tx) => tx<{ id: string }[]>`select id from users where email = 'A@Example.com'`,
        );
        expect(found.map((r) => r.id)).toEqual([A]);
        const id = "018f0000-0000-7000-8000-0000000000ee";
        await inRole(db.database, "aura_auth", anonymous, async (tx) => {
            await tx`insert into users (id, email) values (${id}, 'fresh@example.com')`;
            await tx`insert into profiles (user_id, handle, display_name) values (${id}, 'fresh_one', 'Fresh')`;
        });
        await db.database.sql`delete from users where id = ${id}`;
    });

    it("cannot delete users", async () => {
        await fails(
            inRole(
                db.database,
                "aura_auth",
                anonymous,
                (tx) => tx`delete from users where id = ${A}`,
            ),
            /permission denied/,
        );
    });
});
