// Goal: the in-memory job store (used by simulation) and the PostgreSQL store (used in production)
// behave identically, or the simulation would prove nothing about the real thing. The same random
// operations run against both, every result and the final state of every job must match. Also: the
// real queue under real concurrency (two workers never take the same job, many workers drain a queue
// exactly once), and the database's own guards. Needs PostgreSQL 18 (AURA_TEST_DATABASE_URL).
import { fileURLToPath } from "node:url";
import { withRequestContext } from "@aura/db/context";
import { loadMigrations, migrate } from "@aura/db/migrate";
import { createTestDatabase, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryJobStore } from "../../sim/job-store.ts";
import { createFakeClock, createSeededRng } from "../../sim/world.ts";
import { LEASE_TTL_MS } from "./limits.ts";
import { createPgJobStore } from "./queries.ts";
import { completeJob, enqueueJob, failJob, heartbeatJob, leaseJob, sweepJobs } from "./service.ts";
import type { JobStore } from "./store.ts";

const START = 1_800_000_000_000;
const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;

let db: TestDatabase;
beforeAll(async () => {
    db = await createTestDatabase(8);
    const directory = fileURLToPath(
        new URL("../../../../../packages/db/migrations", import.meta.url),
    );
    await migrate(db.database.sql, loadMigrations(directory));
});
afterAll(async () => {
    await db.drop();
});

// Each call runs in its own transaction, as a worker's call would.
function pgStore(): JobStore {
    const run = <T>(work: (store: JobStore) => Promise<T>) =>
        withRequestContext(db.database.sql, WORKER, (tx) => work(createPgJobStore(tx)));
    return {
        enqueue: (job, now) => run((s) => s.enqueue(job, now)),
        lease: (queue, owner, now, ttl) => run((s) => s.lease(queue, owner, now, ttl)),
        heartbeat: (id, epoch, now, ttl) => run((s) => s.heartbeat(id, epoch, now, ttl)),
        complete: (id, epoch, result, now) => run((s) => s.complete(id, epoch, result, now)),
        fail: (input) => run((s) => s.fail(input)),
        sweep: (now) => run((s) => s.sweep(now)),
        get: (id) => run((s) => s.get(id)),
    };
}

const QUEUES = ["judge", "default"];
const ADVANCES = [1, 4_999, 5_000, 20_000, LEASE_TTL_MS, LEASE_TTL_MS + 1, 100_000, 400_000];

async function playSeed(seed: number, store: JobStore, clearQueue: () => Promise<void>) {
    await clearQueue();
    const clock = createFakeClock(START);
    const rng = createSeededRng(seed);
    const deps = { store, clock, rng };
    const seen: Array<{ id: string; epoch: number }> = [];
    const results: unknown[] = [];
    for (let step = 0; step < 90; step++) {
        const roll = rng.nextInt(100);
        const queue = QUEUES[rng.nextInt(QUEUES.length)] ?? "judge";
        if (roll < 25) {
            const key = rng.nextInt(3) === 0 ? `k${rng.nextInt(3)}` : null;
            results.push(
                await enqueueJob(deps, {
                    kind: "test.job",
                    queue,
                    payload: { n: rng.nextInt(100) },
                    priority: rng.nextInt(10),
                    maxAttempts: 1 + rng.nextInt(4),
                    dedupeKey: key,
                    delayMs: rng.nextInt(3) === 0 ? 7_000 : 0,
                }),
            );
        } else if (roll < 50) {
            const job = await leaseJob(deps, queue, `node-${rng.nextInt(3)}`);
            if (job !== null) seen.push({ id: job.id, epoch: job.leaseEpoch });
            results.push(job);
        } else if (roll < 85 && seen.length > 0) {
            const held = seen[rng.nextInt(seen.length)];
            if (held === undefined) continue;
            const staleBy = rng.nextInt(4) === 0 ? 1 : 0;
            const epoch = held.epoch + staleBy;
            const action = rng.nextInt(3);
            if (action === 0) results.push(await heartbeatJob(deps, held.id, epoch));
            else if (action === 1)
                results.push(await completeJob(deps, held.id, epoch, { ok: true }));
            else
                results.push(
                    await failJob(deps, {
                        id: held.id,
                        epoch,
                        error: "bad\u0007 thing",
                        retryable: rng.nextInt(2) === 0,
                    }),
                );
        } else if (roll < 92) {
            results.push(await sweepJobs(deps));
        } else {
            clock.advance(ADVANCES[rng.nextInt(ADVANCES.length)] ?? 1);
        }
    }
    return { results, seen };
}

describe("memory and PostgreSQL job stores", () => {
    for (let seed = 1; seed <= 12; seed++) {
        it(`agree on every result and the final state (seed ${seed})`, async () => {
            const memory = createMemoryJobStore();
            const pg = pgStore();
            const clear = async () => {
                await db.database.sql`delete from jobs`;
            };
            const memoryRun = await playSeed(seed, memory, async () => undefined);
            const pgRun = await playSeed(seed, pg, clear);
            expect(pgRun.results).toEqual(memoryRun.results);
            const ids = [...new Set(memoryRun.seen.map((s) => s.id))];
            const fromMemory = await Promise.all(ids.map((id) => memory.get(id)));
            const fromPg = await Promise.all(ids.map((id) => pg.get(id)));
            expect(fromPg).toEqual(fromMemory);
        });
    }
});

describe("the real queue under concurrency", () => {
    it("never gives one job to two workers, and drains a queue exactly once", async () => {
        await db.database.sql`delete from jobs`;
        const clock = createFakeClock(START);
        const rng = createSeededRng(99);
        const store = pgStore();
        const deps = { store, clock, rng };
        const total = 60;
        for (let n = 0; n < total; n++) {
            await enqueueJob(deps, {
                kind: "test.job",
                queue: "judge",
                payload: { n },
                priority: n % 3,
            });
        }
        const completed: string[] = [];
        const worker = async (name: string) => {
            // Bounded: at most `total` jobs can ever be leased, plus one empty answer per worker.
            for (let round = 0; round < total + 1; round++) {
                const job = await leaseJob(deps, "judge", name);
                if (job === null) return;
                expect(await completeJob(deps, job.id, job.leaseEpoch, { by: name })).toBe(true);
                completed.push(job.id);
            }
        };
        await Promise.all(Array.from({ length: 8 }, (_, i) => worker(`w${i}`)));
        expect(completed.length).toBe(total);
        expect(new Set(completed).size).toBe(total);
        const [row] = await db.database.sql<
            { n: string }[]
        >`select count(*)::text as n from jobs where state = 'done'`;
        expect(Number(row?.n)).toBe(total);
    });

    it("lets only one of two simultaneous completions with the same epoch win", async () => {
        await db.database.sql`delete from jobs`;
        const clock = createFakeClock(START);
        const store = pgStore();
        const deps = { store, clock, rng: createSeededRng(5) };
        await enqueueJob(deps, { kind: "test.job", queue: "judge", payload: {} });
        const job = await leaseJob(deps, "judge", "w");
        const epoch = job?.leaseEpoch ?? 0;
        const id = job?.id ?? "";
        const outcomes = await Promise.all([
            completeJob(deps, id, epoch, { a: 1 }),
            completeJob(deps, id, epoch, { b: 2 }),
        ]);
        expect(outcomes.filter(Boolean).length).toBe(1);
    });
});

describe("the database's own guards", () => {
    it("hides the queue from the application and identity roles", async () => {
        for (const role of ["aura_app", "aura_auth"] as const) {
            await expect(
                withRequestContext(
                    db.database.sql,
                    { role, actorKind: "anonymous", userId: null, orgIds: [] },
                    (tx) => tx`select id from jobs`,
                ),
            ).rejects.toThrow(/permission denied/);
        }
    });

    it("freezes finished jobs, keeps identity fields, and never lowers the epoch", async () => {
        await db.database.sql`delete from jobs`;
        const clock = createFakeClock(START);
        const deps = { store: pgStore(), clock, rng: createSeededRng(7) };
        const { id } = await enqueueJob(deps, {
            kind: "test.job",
            queue: "judge",
            payload: { a: 1 },
        });
        const job = await leaseJob(deps, "judge", "w");
        const { sql } = db.database;
        await expect(
            sql`update jobs set payload = '{"a":2}'::jsonb where id = ${id}`,
        ).rejects.toThrow(/keeps its kind/);
        await expect(sql`update jobs set lease_epoch = 0 where id = ${id}`).rejects.toThrow(
            /jobs_epoch|only go up/,
        );
        await completeJob(deps, id, job?.leaseEpoch ?? 0, {});
        await expect(
            sql`update jobs set state = 'ready', lease_owner = null, lease_expires_at = null where id = ${id}`,
        ).rejects.toThrow(/finished job/);
    });

    it("refuses malformed rows", async () => {
        const { sql } = db.database;
        const insert = (kind: string, queue: string, priority: number) =>
            sql`insert into jobs (kind, queue, payload, priority, run_after, created_at, updated_at) values (${kind}, ${queue}, '{}'::jsonb, ${priority}, now(), now(), now())`;
        await expect(insert("Bad Kind", "judge", 5)).rejects.toThrow(/jobs_kind/);
        await expect(insert("a.b", "Bad Queue", 5)).rejects.toThrow(/jobs_queue/);
        await expect(insert("a.b", "judge", 10)).rejects.toThrow(/jobs_priority/);
    });
});
