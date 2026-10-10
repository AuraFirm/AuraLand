// Goal: login challenges hold only hashes, move only forward (attempts never fall, a consumed
// challenge never un-consumes), are invisible to the application role, and rate-limit counters
// increment atomically even under concurrency.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const anonymous: RequestContext = { actorKind: "anonymous", userId: null, orgIds: [] };
const hash = (n: number) => Buffer.alloc(32, n);
const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

let db: TestDatabase;
beforeAll(async () => {
    db = await createMigratedTestDatabase(8);
});
afterAll(async () => {
    await db.drop();
});

interface ChallengeInput {
    readonly email: string;
    readonly bindingHash: Buffer;
    readonly linkHash: Buffer;
    readonly codeHash: Buffer;
    readonly linkExpiresAt: string;
    readonly codeExpiresAt: string;
}

async function insertChallenge(
    seed: number,
    overrides: Partial<ChallengeInput> = {},
): Promise<string> {
    const row: ChallengeInput = {
        email: "ada@example.com",
        bindingHash: hash(seed),
        linkHash: hash(seed + 100),
        codeHash: hash(seed + 200),
        linkExpiresAt: "2026-01-01T00:15:00Z",
        codeExpiresAt: "2026-01-01T00:10:00Z",
        ...overrides,
    };
    const [created] = await db.database.sql<{ id: string }[]>`
        insert into login_challenges (email, binding_hash, link_hash, code_hash, created_at,
                                      link_expires_at, code_expires_at)
        values (${row.email}, ${row.bindingHash}, ${row.linkHash}, ${row.codeHash},
                '2026-01-01T00:00:00Z', ${row.linkExpiresAt}, ${row.codeExpiresAt})
        returning id`;
    return created?.id ?? "";
}

describe("login_challenges rules", () => {
    it("accepts a valid challenge and refuses duplicate binding or link hashes", async () => {
        await insertChallenge(1);
        await fails(insertChallenge(1, { linkHash: hash(150) }), /duplicate key/);
        await fails(insertChallenge(2, { linkHash: hash(101) }), /duplicate key/);
    });

    it("requires lowercase email, 32-byte hashes and expiries after creation", async () => {
        await fails(
            insertChallenge(3, { email: "Ada@Example.com" }),
            /login_challenges_email_lowercase/,
        );
        await fails(
            insertChallenge(4, { codeHash: Buffer.alloc(8, 1) }),
            /login_challenges_code_hash_size/,
        );
        await fails(
            insertChallenge(5, { linkExpiresAt: "2025-12-31T00:00:00Z" }),
            /login_challenges_expiry/,
        );
        await fails(
            insertChallenge(6, { codeExpiresAt: "2026-01-01T00:00:00Z" }),
            /login_challenges_expiry/,
        );
    });

    it("limits attempts to 0 through 5 and ties consumption time to its method", async () => {
        const id = await insertChallenge(7);
        const { sql } = db.database;
        await fails(
            sql`update login_challenges set code_attempts = 6 where id = ${id}`,
            /login_challenges_attempts/,
        );
        await fails(
            sql`update login_challenges set consumed_at = now() where id = ${id}`,
            /login_challenges_consumed_pair/,
        );
        await fails(
            sql`update login_challenges set consumed_by = 'code' where id = ${id}`,
            /login_challenges_consumed_pair/,
        );
        await fails(
            sql`update login_challenges set consumed_at = now(), consumed_by = 'sms' where id = ${id}`,
            /login_challenges_consumed_by/,
        );
    });

    it("never lets attempts fall or a consumed challenge be changed", async () => {
        const id = await insertChallenge(8);
        const { sql } = db.database;
        await sql`update login_challenges set code_attempts = 3 where id = ${id}`;
        await fails(
            sql`update login_challenges set code_attempts = 2 where id = ${id}`,
            /only move forward/,
        );
        await sql`update login_challenges set consumed_at = now(), consumed_by = 'code' where id = ${id}`;
        await fails(
            sql`update login_challenges set consumed_at = null, consumed_by = null where id = ${id}`,
            /only move forward/,
        );
        await fails(
            sql`update login_challenges set consumed_by = 'link' where id = ${id}`,
            /only move forward/,
        );
        await fails(
            sql`update login_challenges set code_attempts = 4 where id = ${id}`,
            /only move forward/,
        );
    });
});

describe("who may touch login_challenges", () => {
    it("is invisible to the application role in every way", async () => {
        for (const statement of [
            (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => tx`select 1 from login_challenges`,
            (tx: Parameters<Parameters<typeof inRole>[3]>[0]) =>
                tx`select code_hash from login_challenges`,
            (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => tx`delete from login_challenges`,
        ]) {
            await fails(inRole(db.database, "aura_app", anonymous, statement), /permission denied/);
        }
    });

    it("lets the identity role create and advance challenges but not rewrite their secrets", async () => {
        const id = await inRole(db.database, "aura_auth", anonymous, async (tx) => {
            const [row] = await tx<
                { id: string }[]
            >`insert into login_challenges (email, binding_hash, link_hash, code_hash, created_at, link_expires_at, code_expires_at) values ('grace@example.com', ${hash(60)}, ${hash(61)}, ${hash(62)}, now(), now() + interval '15 minutes', now() + interval '10 minutes') returning id`;
            return row?.id ?? "";
        });
        await inRole(
            db.database,
            "aura_auth",
            anonymous,
            (tx) =>
                tx`update login_challenges set code_attempts = code_attempts + 1 where id = ${id}`,
        );
        await fails(
            inRole(
                db.database,
                "aura_auth",
                anonymous,
                (tx) => tx`update login_challenges set code_hash = ${hash(9)} where id = ${id}`,
            ),
            /permission denied/,
        );
        await fails(
            inRole(
                db.database,
                "aura_auth",
                anonymous,
                (tx) => tx`update login_challenges set email = 'x@example.com' where id = ${id}`,
            ),
            /permission denied/,
        );
        await fails(
            inRole(
                db.database,
                "aura_auth",
                anonymous,
                (tx) => tx`delete from login_challenges where id = ${id}`,
            ),
            /permission denied/,
        );
    });
});

describe("rate_limit_counters", () => {
    const bump = (key: number, windowStart: string) =>
        inRole(db.database, "aura_auth", anonymous, async (tx) => {
            const [row] = await tx<{ count: number }[]>`
                insert into rate_limit_counters (key_hash, window_start, count)
                values (${hash(key)}, ${windowStart}, 1)
                on conflict (key_hash, window_start) do update set count = rate_limit_counters.count + 1
                returning count`;
            return row?.count ?? 0;
        });

    it("counts atomically under concurrency, per key and per window", async () => {
        const results = await Promise.all(
            Array.from({ length: 20 }, () => bump(1, "2026-01-01T00:00:00Z")),
        );
        expect([...results].sort((a, b) => a - b)).toEqual(
            Array.from({ length: 20 }, (_, i) => i + 1),
        );
        expect(await bump(2, "2026-01-01T00:00:00Z")).toBe(1);
        expect(await bump(1, "2026-01-01T00:01:00Z")).toBe(1);
    });

    it("refuses bad keys and counts, and is closed to the application role", async () => {
        await fails(
            db.database
                .sql`insert into rate_limit_counters (key_hash, window_start, count) values (${Buffer.alloc(5)}, now(), 1)`,
            /rate_limit_counters_key_size/,
        );
        await fails(
            db.database
                .sql`insert into rate_limit_counters (key_hash, window_start, count) values (${hash(3)}, now(), 0)`,
            /rate_limit_counters_count/,
        );
        await fails(
            inRole(
                db.database,
                "aura_app",
                anonymous,
                (tx) => tx`select 1 from rate_limit_counters`,
            ),
            /permission denied/,
        );
    });
});
