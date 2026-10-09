// Goal: the sessions table must hold only token hashes, enforce sane times, only ever move toward
// "revoked", show a person just their own sessions without the hash column, and give the identity
// role the narrow rights it needs and no more.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const A = "018f0000-0000-7000-8000-0000000000aa";
const B = "018f0000-0000-7000-8000-0000000000bb";
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const anonymous: RequestContext = { actorKind: "anonymous", userId: null, orgIds: [] };
const hash = (n: number) => Buffer.alloc(32, n);

let db: TestDatabase;
beforeAll(async () => {
    db = await createMigratedTestDatabase();
    await db.database
        .sql`insert into users (id, email) values (${A}, 'a@example.com'), (${B}, 'b@example.com')`;
});
afterAll(async () => {
    await db.drop();
});

async function insertSession(
    userId: string,
    tokenByte: number,
    overrides: Record<string, unknown> = {},
) {
    const row = {
        user_id: userId,
        token_hash: hash(tokenByte),
        auth_method: "passkey",
        privileged: false,
        created_at: "2026-01-01T00:00:00Z",
        last_seen_at: "2026-01-01T00:00:00Z",
        idle_expires_at: "2026-01-08T00:00:00Z",
        absolute_expires_at: "2026-01-31T00:00:00Z",
        ...overrides,
    };
    const { sql } = db.database;
    const [created] = await sql<{ id: string }[]>`
        insert into sessions (user_id, token_hash, auth_method, privileged, created_at, last_seen_at,
                              idle_expires_at, absolute_expires_at)
        values (${row.user_id as string}, ${row.token_hash as Buffer}, ${row.auth_method as string},
                ${row.privileged as boolean}, ${row.created_at as string}, ${row.last_seen_at as string},
                ${row.idle_expires_at as string}, ${row.absolute_expires_at as string})
        returning id`;
    return created?.id ?? "";
}

const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

describe("session row rules", () => {
    it("accepts a valid row and refuses a duplicate token hash", async () => {
        await insertSession(A, 1);
        await fails(insertSession(B, 1), /duplicate key/);
    });

    it("refuses hashes of the wrong size, unknown methods and impossible times", async () => {
        await fails(
            insertSession(A, 2, { token_hash: Buffer.alloc(31, 2) }),
            /sessions_token_hash_size/,
        );
        await fails(insertSession(A, 3, { auth_method: "password" }), /sessions_auth_method_check/);
        await fails(
            insertSession(A, 4, { idle_expires_at: "2026-02-01T00:00:00Z" }),
            /sessions_times_ordered/,
        );
        await fails(
            insertSession(A, 5, { last_seen_at: "2025-12-31T00:00:00Z" }),
            /sessions_times_ordered/,
        );
    });

    it("only moves toward revoked: a revoked session cannot be revived or re-reasoned", async () => {
        const id = await insertSession(A, 6);
        const { sql } = db.database;
        await sql`update sessions set revoked_at = now(), revoked_reason = 'logout' where id = ${id}`;
        await fails(
            sql`update sessions set revoked_at = null, revoked_reason = null where id = ${id}`,
            /revoked session/,
        );
        await fails(
            sql`update sessions set revoked_reason = 'admin' where id = ${id}`,
            /revoked session/,
        );
    });

    it("requires a reason exactly when revoked", async () => {
        const id = await insertSession(A, 7);
        await fails(
            db.database.sql`update sessions set revoked_at = now() where id = ${id}`,
            /sessions_revoked_pair/,
        );
    });

    it("is removed together with its user", async () => {
        const gone = "018f0000-0000-7000-8000-0000000000fe";
        await db.database.sql`insert into users (id, email) values (${gone}, 'gone@example.com')`;
        await insertSession(gone, 8);
        await db.database.sql`delete from users where id = ${gone}`;
        const rows = await db.database.sql`select 1 from sessions where token_hash = ${hash(8)}`;
        expect(rows.length).toBe(0);
    });
});

describe("what the application roles may do", () => {
    it("shows a person their own sessions without ever exposing the hash column", async () => {
        const mine = await inRole(
            db.database,
            "aura_app",
            as(A),
            (tx) => tx<{ id: string }[]>`select id, auth_method from sessions`,
        );
        expect(mine.length).toBeGreaterThan(0);
        await fails(
            inRole(db.database, "aura_app", as(A), (tx) => tx`select token_hash from sessions`),
            /permission denied/,
        );
        await fails(
            inRole(db.database, "aura_app", as(A), (tx) => tx`select * from sessions`),
            /permission denied/,
        );
        const none = await inRole(
            db.database,
            "aura_app",
            anonymous,
            (tx) => tx`select id from sessions`,
        );
        expect(none.length).toBe(0);
    });

    it("lets a person revoke only their own sessions", async () => {
        const mineId = await insertSession(A, 9);
        const theirsId = await insertSession(B, 10);
        await inRole(
            db.database,
            "aura_app",
            as(A),
            (tx) =>
                tx`update sessions set revoked_at = now(), revoked_reason = 'logout' where id = ${mineId}`,
        );
        const other = await inRole(
            db.database,
            "aura_app",
            as(A),
            (tx) =>
                tx`update sessions set revoked_at = now(), revoked_reason = 'logout' where id = ${theirsId}`,
        );
        expect(other.count).toBe(0);
    });

    it("cannot create sessions or change anything but the revocation columns", async () => {
        const id = await insertSession(A, 11);
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(A),
                (tx) =>
                    tx`insert into sessions (user_id, token_hash, auth_method, privileged, created_at, last_seen_at, idle_expires_at, absolute_expires_at) values (${A}, ${hash(99)}, 'passkey', false, now(), now(), now() + interval '1 hour', now() + interval '1 day')`,
            ),
            /permission denied/,
        );
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(A),
                (tx) =>
                    tx`update sessions set absolute_expires_at = now() + interval '1 year' where id = ${id}`,
            ),
            /permission denied/,
        );
    });
});

describe("what the identity role may do", () => {
    it("creates sessions, reads them by hash, and updates only the lifecycle columns", async () => {
        const id = await inRole(db.database, "aura_auth", anonymous, async (tx) => {
            const [row] = await tx<
                { id: string }[]
            >`insert into sessions (user_id, token_hash, auth_method, privileged, created_at, last_seen_at, idle_expires_at, absolute_expires_at) values (${A}, ${hash(50)}, 'email_link', false, now(), now(), now() + interval '1 hour', now() + interval '1 day') returning id`;
            return row?.id ?? "";
        });
        const found = await inRole(
            db.database,
            "aura_auth",
            anonymous,
            (tx) => tx<{ id: string }[]>`select id from sessions where token_hash = ${hash(50)}`,
        );
        expect(found[0]?.id).toBe(id);
        await inRole(
            db.database,
            "aura_auth",
            anonymous,
            (tx) =>
                tx`update sessions set last_seen_at = now(), idle_expires_at = now() + interval '2 hours' where id = ${id}`,
        );
        await fails(
            inRole(
                db.database,
                "aura_auth",
                anonymous,
                (tx) => tx`update sessions set token_hash = ${hash(51)} where id = ${id}`,
            ),
            /permission denied/,
        );
        await fails(
            inRole(
                db.database,
                "aura_auth",
                anonymous,
                (tx) => tx`update sessions set user_id = ${B} where id = ${id}`,
            ),
            /permission denied/,
        );
        await fails(
            inRole(
                db.database,
                "aura_auth",
                anonymous,
                (tx) => tx`delete from sessions where id = ${id}`,
            ),
            /permission denied/,
        );
    });
});
