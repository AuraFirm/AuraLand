// Goal: the in-memory challenge store (used by simulation) and the PostgreSQL store (used in
// production) must behave identically, or the simulation would prove nothing about the real thing.
// The same randomized operations run against both; every result and the final stored state must
// match exactly. Needs PostgreSQL 18 (AURA_TEST_DATABASE_URL).
import { fileURLToPath } from "node:url";
import { withRequestContext } from "@aura/db/context";
import { loadMigrations, migrate } from "@aura/db/migrate";
import { createTestDatabase, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryChallengeStore } from "../../sim/challenge-store.ts";
import { createFakeClock, createSeededRng } from "../../sim/world.ts";
import { LOGIN_CODE_ATTEMPTS_MAX } from "./limits.ts";
import { type ChallengeStore, hashSecret, type NewChallenge, newChallenge } from "./login.ts";
import { createPgChallengeStore, readChallenges } from "./queries.ts";

const KEY = Buffer.alloc(32, 5);
const START = 1_800_000_000_000;
const JUMPS_S = [1, 59, 60, 299, 599, 600, 601, 899, 900, 901, 3600];
const SEEDS = 10;
const OPERATIONS_PER_SEED = 60;

let db: TestDatabase;
beforeAll(async () => {
    db = await createTestDatabase(4);
    const directory = fileURLToPath(
        new URL("../../../../../packages/db/migrations", import.meta.url),
    );
    await migrate(db.database.sql, loadMigrations(directory));
});
afterAll(async () => {
    await db.drop();
});

type Operation =
    | { kind: "start"; email: number }
    | {
          kind: "codeRight" | "codeWrong" | "codeOtherBinding" | "linkRight" | "linkOtherBinding";
          pick: number;
      }
    | { kind: "advance"; seconds: number };

function plan(seed: number): Operation[] {
    const rng = createSeededRng(seed * 104729 + 3);
    const kinds = [
        "start",
        "codeRight",
        "codeWrong",
        "codeWrong",
        "codeWrong",
        "codeOtherBinding",
        "linkRight",
        "linkOtherBinding",
        "advance",
        "advance",
    ] as const;
    return Array.from({ length: OPERATIONS_PER_SEED }, (): Operation => {
        const kind = kinds[rng.nextInt(kinds.length)] ?? "start";
        if (kind === "start") return { kind, email: rng.nextInt(4) };
        if (kind === "advance") return { kind, seconds: JUMPS_S[rng.nextInt(JUMPS_S.length)] ?? 1 };
        return { kind, pick: rng.nextInt(1_000_000) };
    });
}

// Applies one operation to a store. The same function drives both stores.
async function apply(
    op: Operation,
    store: ChallengeStore,
    made: NewChallenge[],
    nowMs: number,
    d: { rng: ReturnType<typeof createSeededRng> },
) {
    if (op.kind === "advance") return null;
    if (op.kind === "start") {
        const fresh = newChallenge(
            { clock: { nowUnixMs: () => nowMs }, rng: d.rng, key: KEY },
            `user${op.email}@example.com`,
        );
        made.push(fresh);
        await store.insert(fresh.record);
        return fresh.record.id;
    }
    const target = made[op.pick % Math.max(made.length, 1)];
    if (target === undefined) return null;
    const binding = hashSecret(KEY, "binding", target.binding);
    const stranger = hashSecret(KEY, "binding", "someone-else");
    switch (op.kind) {
        case "codeRight":
            return store.tryCode(binding, hashSecret(KEY, "code", target.code), nowMs);
        case "codeWrong": {
            const wrong = String((Number(target.code) + 1) % 10 ** 8).padStart(8, "0");
            return store.tryCode(binding, hashSecret(KEY, "code", wrong), nowMs);
        }
        case "codeOtherBinding":
            return store.tryCode(stranger, hashSecret(KEY, "code", target.code), nowMs);
        case "linkRight":
            return store.consumeWithLink(binding, hashSecret(KEY, "link", target.token), nowMs);
        case "linkOtherBinding":
            return store.consumeWithLink(stranger, hashSecret(KEY, "link", target.token), nowMs);
    }
}

describe("memory challenge store equals PostgreSQL challenge store", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
        it(`gives identical results for seed ${seed}`, async () => {
            const { sql } = db.database;
            await sql`delete from login_challenges`;
            const memory = createMemoryChallengeStore();
            const clock = createFakeClock(START);
            const memoryMade: NewChallenge[] = [];
            const pgMade: NewChallenge[] = [];
            const memoryRng = createSeededRng(seed);
            const pgRng = createSeededRng(seed);
            for (const [step, op] of plan(seed).entries()) {
                if (op.kind === "advance") clock.advance(op.seconds * 1000);
                const nowMs = clock.nowUnixMs();
                const fromMemory = await apply(op, memory, memoryMade, nowMs, { rng: memoryRng });
                const fromPg = await withRequestContext(
                    sql,
                    { role: "aura_auth", actorKind: "anonymous", userId: null, orgIds: [] },
                    (tx) =>
                        apply(
                            op,
                            createPgChallengeStore(tx, LOGIN_CODE_ATTEMPTS_MAX),
                            pgMade,
                            nowMs,
                            { rng: pgRng },
                        ),
                );
                expect(fromPg, `seed ${seed} step ${step} ${JSON.stringify(op)}`).toEqual(
                    fromMemory,
                );
            }
            const stored = await withRequestContext(
                sql,
                { role: "aura_auth", actorKind: "anonymous", userId: null, orgIds: [] },
                (tx) => readChallenges(tx),
            );
            const sortKey = (r: { createdAtMs: number; id: string }) =>
                `${String(r.createdAtMs).padStart(16, "0")}${r.id}`;
            expect(stored).toEqual(memory.all().sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)));
        });
    }
});

describe("memory and PostgreSQL stores agree on a guess flood", () => {
    // Random runs rarely put six wrong guesses on one challenge, so this is spelled out: five wrong
    // guesses lock the code for good, even for the right code, while the link still works.
    it("locks the code after five wrong guesses and still allows the link", async () => {
        const { sql } = db.database;
        await sql`delete from login_challenges`;
        const clock = createFakeClock(START);
        const fresh = newChallenge(
            { clock, rng: createSeededRng(99), key: KEY },
            "flood@example.com",
        );
        const binding = hashSecret(KEY, "binding", fresh.binding);
        const wrong = hashSecret(KEY, "code", "00000000" === fresh.code ? "00000001" : "00000000");
        const right = hashSecret(KEY, "code", fresh.code);
        const link = hashSecret(KEY, "link", fresh.token);
        const script = async (store: ChallengeStore) => {
            await store.insert(fresh.record);
            const results: unknown[] = [];
            for (let guess = 0; guess < LOGIN_CODE_ATTEMPTS_MAX + 3; guess++) {
                results.push(await store.tryCode(binding, wrong, START + 1000));
            }
            results.push(await store.tryCode(binding, right, START + 2000));
            results.push(await store.consumeWithLink(binding, link, START + 3000));
            results.push(await store.consumeWithLink(binding, link, START + 4000));
            return results;
        };
        const fromMemory = await script(createMemoryChallengeStore());
        const fromPg = await withRequestContext(
            sql,
            { role: "aura_auth", actorKind: "anonymous", userId: null, orgIds: [] },
            (tx) => script(createPgChallengeStore(tx, LOGIN_CODE_ATTEMPTS_MAX)),
        );
        expect(fromPg).toEqual(fromMemory);
        const attempts = fromMemory.slice(0, LOGIN_CODE_ATTEMPTS_MAX + 3);
        expect(attempts.slice(0, LOGIN_CODE_ATTEMPTS_MAX)).toEqual(
            Array.from({ length: LOGIN_CODE_ATTEMPTS_MAX }, (_, i) => ({
                consumed: false,
                attempts: i + 1,
            })),
        );
        expect(attempts.slice(LOGIN_CODE_ATTEMPTS_MAX)).toEqual([null, null, null]);
        expect(fromMemory.slice(-3)).toEqual([null, { email: "flood@example.com" }, null]);
    });
});
