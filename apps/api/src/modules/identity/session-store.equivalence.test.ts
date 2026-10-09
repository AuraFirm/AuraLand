// Goal: the in-memory session store (used by simulation) and the PostgreSQL store (used in
// production) must behave identically, or the simulation would prove nothing about the real thing.
// The same randomized operations run against both, and every result, plus the final state of every
// issued session, must match exactly. Needs a PostgreSQL 18 server (AURA_TEST_DATABASE_URL).

import { fileURLToPath } from "node:url";
import { withRequestContext } from "@aura/db/context";
import { loadMigrations, migrate } from "@aura/db/migrate";
import { createTestDatabase, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemorySessionStore } from "../../sim/session-store.ts";
import { createFakeClock, createSeededRng } from "../../sim/world.ts";
import { createPgSessionStore } from "./queries.ts";
import type { UserStatus } from "./rules.ts";
import {
    createSession,
    hashToken,
    revokeAllSessions,
    revokeSession,
    rotateSession,
    type SessionDeps,
    validateSession,
} from "./service.ts";

const USERS = [
    "018f0000-0000-7000-8000-000000000001",
    "018f0000-0000-7000-8000-000000000002",
    "018f0000-0000-7000-8000-000000000003",
] as const;
const START = 1_800_000_000_000;
const SECONDS = [1, 30, 61, 300, 2400, 7200, 28800, 259200, 864000, 2678400];
const SEEDS = 12;
// The last seeds hammer one user with logins so the per-user session cap and eviction are compared.
const HEAVY_FROM_SEED = 10;
const OPERATIONS_PER_SEED = 70;

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
    | { kind: "create"; user: number; privileged: boolean; method: "passkey" | "email_link" }
    | { kind: "validate"; pick: number; garbage: boolean }
    | { kind: "rotate"; pick: number }
    | { kind: "revoke"; pick: number }
    | { kind: "revokeAll"; user: number; keepPick: number | null }
    | { kind: "list"; user: number }
    | { kind: "advance"; seconds: number }
    | { kind: "status"; user: number; status: UserStatus };

function planOperations(seed: number): Operation[] {
    const heavy = seed >= HEAVY_FROM_SEED;
    const rng = createSeededRng(seed * 7919 + 13);
    const plan: Operation[] = [];
    for (let i = 0; i < OPERATIONS_PER_SEED; i++) {
        const roll = rng.nextInt(100);
        const user = heavy ? 0 : rng.nextInt(USERS.length);
        const pick = rng.nextInt(1_000_000);
        if (heavy ? roll < 75 : roll < 28)
            plan.push({
                kind: "create",
                user,
                privileged: rng.nextInt(2) === 0,
                method: rng.nextInt(2) === 0 ? "passkey" : "email_link",
            });
        else if (roll < 55) plan.push({ kind: "validate", pick, garbage: rng.nextInt(8) === 0 });
        else if (roll < 63) plan.push({ kind: "rotate", pick });
        else if (roll < 71) plan.push({ kind: "revoke", pick });
        else if (roll < 76)
            plan.push({ kind: "revokeAll", user, keepPick: rng.nextInt(2) === 0 ? pick : null });
        else if (roll < 82) plan.push({ kind: "list", user });
        else if (roll < 94)
            plan.push({ kind: "advance", seconds: SECONDS[rng.nextInt(SECONDS.length)] ?? 1 });
        else
            plan.push({
                kind: "status",
                user,
                status: rng.nextInt(2) === 0 ? "suspended" : "active",
            });
    }
    return plan;
}

interface Side {
    run(operation: Operation): Promise<unknown>;
    sessions(): Promise<unknown[]>;
}

type Issued = Array<{ token: string; id: string }>;
const UNKNOWN_TOKEN = "A".repeat(43);

// Performs one store-touching operation through the service. Both sides call this same function, so
// any difference in the results can only come from the store underneath.
async function execute(
    operation: Operation,
    deps: SessionDeps,
    issued: Issued,
    nowMs: number,
): Promise<unknown> {
    const issuedAt = (pick: number) => issued[pick % Math.max(issued.length, 1)];
    switch (operation.kind) {
        case "create": {
            const userId = USERS[operation.user] ?? "";
            const made = await createSession(deps, {
                userId,
                authMethod: operation.method,
                privileged: operation.privileged,
            });
            issued.push({ token: made.token, id: made.session.id });
            return made;
        }
        case "validate": {
            const token = operation.garbage ? UNKNOWN_TOKEN : issuedAt(operation.pick)?.token;
            return validateSession(deps, token ?? UNKNOWN_TOKEN);
        }
        case "rotate": {
            const result = await rotateSession(
                deps,
                issuedAt(operation.pick)?.token ?? UNKNOWN_TOKEN,
            );
            if (result.ok) issued.push({ token: result.token, id: result.session.id });
            return result;
        }
        case "revoke":
            return revokeSession(deps, issuedAt(operation.pick)?.id ?? USERS[0], "admin");
        case "revokeAll": {
            const keepId =
                operation.keepPick === null ? null : (issuedAt(operation.keepPick)?.id ?? null);
            return revokeAllSessions(deps, USERS[operation.user] ?? "", "logout_all", keepId);
        }
        case "list":
            return deps.store.listActive(USERS[operation.user] ?? "", nowMs);
        default:
            return null;
    }
}

interface SideOptions {
    readonly seed: number;
    // Supplies a store: the memory one directly, or a new PostgreSQL one inside a transaction as
    // the identity role for each operation.
    readonly withDeps: (
        use: (deps: SessionDeps) => Promise<unknown>,
        clock: ReturnType<typeof createFakeClock>,
        rng: ReturnType<typeof createSeededRng>,
    ) => Promise<unknown>;
    readonly onStatus: (user: number, status: UserStatus) => Promise<void>;
}

function makeSide({ seed, withDeps, onStatus }: SideOptions): Side {
    const clock = createFakeClock(START);
    const rng = createSeededRng(seed);
    const issued: Issued = [];
    return {
        async run(operation) {
            if (operation.kind === "advance") {
                clock.advance(operation.seconds * 1000);
                return null;
            }
            if (operation.kind === "status") {
                await onStatus(operation.user, operation.status);
                return null;
            }
            const nowMs = clock.nowUnixMs();
            return withDeps((deps) => execute(operation, deps, issued, nowMs), clock, rng);
        },
        async sessions() {
            const out: unknown[] = [];
            for (const entry of issued) {
                const found = (deps: SessionDeps) =>
                    deps.store.findByTokenHash(hashToken(entry.token));
                out.push(await withDeps(found, clock, rng));
            }
            return out;
        },
    };
}

describe("memory store equals PostgreSQL store", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
        it(`gives identical results for seed ${seed}`, async () => {
            const statuses = new Map<string, UserStatus>();
            const memoryStore = createMemorySessionStore(
                (userId) => statuses.get(userId) ?? "active",
            );
            const memory = makeSide({
                seed,
                withDeps: (use, clock, rng) => use({ store: memoryStore, clock, rng }),
                onStatus: async (user, status) => void statuses.set(USERS[user] ?? "", status),
            });
            const { sql } = db.database;
            await sql`delete from sessions`;
            await sql`delete from users`;
            for (const [index, id] of USERS.entries())
                await sql`insert into users (id, email) values (${id}, ${`u${index}@example.com`})`;
            const pg = makeSide({
                seed,
                withDeps: (use, clock, rng) =>
                    withRequestContext(
                        sql,
                        { role: "aura_auth", actorKind: "anonymous", userId: null, orgIds: [] },
                        (tx) => use({ store: createPgSessionStore(tx), clock, rng }),
                    ),
                onStatus: async (user, status) =>
                    void (await sql`update users set status = ${status} where id = ${USERS[user] ?? ""}`),
            });
            const plan = planOperations(seed);
            for (const [step, operation] of plan.entries()) {
                const fromMemory = await memory.run(operation);
                const fromPg = await pg.run(operation);
                expect(fromPg, `seed ${seed} step ${step} ${JSON.stringify(operation)}`).toEqual(
                    fromMemory,
                );
            }
            expect(await pg.sessions()).toEqual(await memory.sessions());
        });
    }
});

describe("memory store equals PostgreSQL store at the absolute limit", () => {
    // A session used daily keeps a future idle expiry, so only the absolute 30-day limit ends it.
    // This is the one case where the two expiry checks differ, and the random runs rarely reach it.
    it("lists and validates a daily-used session identically up to and past day 30", async () => {
        const { sql } = db.database;
        await sql`delete from sessions`;
        await sql`delete from users`;
        await sql`insert into users (id, email) values (${USERS[0]}, 'long@example.com')`;
        const statuses = new Map<string, UserStatus>();
        const memoryStore = createMemorySessionStore((id) => statuses.get(id) ?? "active");
        const clockM = createFakeClock(START);
        const clockP = createFakeClock(START);
        const memoryDeps: SessionDeps = {
            store: memoryStore,
            clock: clockM,
            rng: createSeededRng(77),
        };
        const asIdentity = <T>(use: (deps: SessionDeps) => Promise<T>) =>
            withRequestContext(
                sql,
                { role: "aura_auth", actorKind: "anonymous", userId: null, orgIds: [] },
                (tx) =>
                    use({
                        store: createPgSessionStore(tx),
                        clock: clockP,
                        rng: createSeededRng(77),
                    }),
            );
        const made = await createSession(memoryDeps, {
            userId: USERS[0],
            authMethod: "email_link",
            privileged: false,
        });
        await asIdentity((deps) =>
            createSession(deps, { userId: USERS[0], authMethod: "email_link", privileged: false }),
        );
        for (let day = 1; day <= 32; day++) {
            clockM.advance(24 * 3600 * 1000);
            clockP.advance(24 * 3600 * 1000);
            const fromMemory = await validateSession(memoryDeps, made.token);
            const fromPg = await asIdentity((deps) => validateSession(deps, made.token));
            expect(fromPg, `day ${day}`).toEqual(fromMemory);
            const listedMemory = await memoryStore.listActive(USERS[0], clockM.nowUnixMs());
            const listedPg = await asIdentity((deps) =>
                deps.store.listActive(USERS[0], clockP.nowUnixMs()),
            );
            expect(listedPg, `day ${day} list`).toEqual(listedMemory);
            if (day === 29) expect(fromMemory.ok).toBe(true);
            if (day >= 30) expect(listedMemory.length).toBe(0);
        }
    });
});
