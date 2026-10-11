import { assert } from "@aura/contracts/assert";
import { ATTEMPTS_DEFAULT, LEASE_TTL_MS } from "../modules/jobs/limits.ts";
import { backoffMs, type JobRecord } from "../modules/jobs/rules.ts";
import {
    completeJob,
    enqueueJob,
    failJob,
    heartbeatJob,
    leaseJob,
    sweepJobs,
} from "../modules/jobs/service.ts";
import { createMemoryJobStore } from "./job-store.ts";
import type { Scenario } from "./runner.ts";
import type { World } from "./world.ts";

// Goal: drive the queue with random enqueues, leases by several nodes, heartbeats, completions,
// failures, crashed nodes (they simply stop) and passing time, and check an independent model of the
// rules. Invariants: a job has at most one live lease and its epoch rises with every lease; a result
// or failure with a stale epoch changes nothing; a finished job never changes; attempts never exceed
// the maximum; no job is ever lost; a duplicate dedupe key never creates a second unfinished job.

const NODES = ["node-a", "node-b", "node-c"] as const;
const QUEUES = ["judge", "default"] as const;
const ADVANCES_MS = [
    1,
    1_000,
    9_999,
    10_000,
    LEASE_TTL_MS - 1,
    LEASE_TTL_MS,
    LEASE_TTL_MS + 1,
    60_000,
    400_000,
];

// What a node believes it holds: the job and the epoch it was given.
interface Held {
    readonly id: string;
    readonly epoch: number;
}

interface Run {
    readonly world: World;
    readonly store: ReturnType<typeof createMemoryJobStore>;
    readonly deps: {
        store: ReturnType<typeof createMemoryJobStore>;
        clock: World["clock"];
        rng: World["rng"];
    };
    // Highest epoch ever handed out, per job; epochs must rise by exactly one per lease.
    readonly epochs: Map<string, number>;
    readonly finished: Map<string, "done" | "dead">;
    readonly enqueued: Set<string>;
    readonly held: Held[];
    readonly keys: Map<string, string>; // queue|dedupe -> id of the last job created with it
}

function pick<T>(world: World, items: readonly T[]): T {
    const item = items[world.rng.nextInt(items.length)];
    assert(item !== undefined, "list is not empty");
    return item;
}

async function opEnqueue(run: Run): Promise<void> {
    const { world, store } = run;
    const queue = pick(world, QUEUES);
    const key = world.rng.nextInt(3) === 0 ? `k${world.rng.nextInt(4)}` : null;
    // Is an unfinished job with this key already there? Asked before enqueueing.
    const slot = `${queue}|${key}`;
    const known = run.keys.get(slot);
    const open = store
        .all()
        .some((j) => j.id === known && (j.state === "ready" || j.state === "leased"));
    const result = await enqueueJob(run.deps, {
        kind: "test.job",
        queue,
        payload: { n: world.rng.nextInt(1000) },
        priority: world.rng.nextInt(10),
        maxAttempts: 1 + world.rng.nextInt(ATTEMPTS_DEFAULT),
        dedupeKey: key,
    });
    if (key !== null) {
        assert(result.created === !open, "dedupe creates only when no unfinished twin exists");
        if (!result.created) assert(result.id === known, "dedupe returns the existing job");
        run.keys.set(slot, result.id);
    }
    run.enqueued.add(result.id);
}

async function opLease(run: Run): Promise<void> {
    const node = pick(run.world, NODES);
    const job = await leaseJob(run.deps, pick(run.world, QUEUES), node);
    if (job === null) return;
    const before = run.epochs.get(job.id) ?? 0;
    assert(job.leaseEpoch === before + 1, "every lease raises the epoch by exactly one");
    assert(job.state === "leased" && job.leaseOwner === node, "a leased job names its owner");
    assert(job.attempt <= job.maxAttempts, "attempts never exceed the maximum");
    run.epochs.set(job.id, job.leaseEpoch);
    // Older holders of this job stay in the list on purpose, so their stale calls keep being tested.
    run.held.push({ id: job.id, epoch: job.leaseEpoch });
}

async function opFail(run: Run, held: Held, current: boolean, before: JobRecord | null) {
    const retryable = run.world.rng.nextInt(2) === 0;
    const outcome = await failJob(run.deps, {
        id: held.id,
        epoch: held.epoch,
        error: "boom",
        retryable,
    });
    assert((outcome === "stale") === !current, "a failure counts exactly for the current lease");
    if (current && before !== null) {
        const expected = retryable && before.attempt < before.maxAttempts ? "retried" : "dead";
        assert(outcome === expected, "a failure is retried only if retryable and attempts remain");
    }
    return outcome !== "stale";
}

async function opWork(run: Run): Promise<void> {
    if (run.held.length === 0) return;
    const index = run.world.rng.nextInt(run.held.length);
    const held = run.held[index];
    assert(held !== undefined, "held entry exists");
    const before = await run.store.get(held.id);
    const current =
        before !== null && before.state === "leased" && before.leaseEpoch === held.epoch;
    const action = run.world.rng.nextInt(4);
    let consumed = false;
    if (action === 0) {
        const ok = await heartbeatJob(run.deps, held.id, held.epoch);
        assert(ok === current, "a heartbeat works exactly for the current lease");
    } else if (action === 1) {
        consumed = await completeJob(run.deps, held.id, held.epoch, { v: "x" });
        assert(consumed === current, "a result is accepted exactly for the current lease");
    } else if (action === 2) {
        consumed = await opFail(run, held, current, before);
    }
    // action 3: the node crashes silently; its lease must expire by itself.
    if (consumed) run.held.splice(index, 1);
    const after = await run.store.get(held.id);
    if (!current && before !== null && after !== null) {
        assert(JSON.stringify(after) === JSON.stringify(before), "a stale call changes nothing");
    }
}

function checkJob(run: Run, job: JobRecord, nowMs: number): void {
    assert(job.attempt <= job.maxAttempts, "attempts within the maximum");
    assert(job.leaseEpoch >= (run.epochs.get(job.id) ?? 0), "the epoch never goes down");
    assert(
        (job.state === "leased") === (job.leaseOwner !== null),
        "an owner exists exactly while leased",
    );
    const done = run.finished.get(job.id);
    if (done !== undefined) assert(job.state === done, "a finished job never changes");
    if (job.state === "ready" && job.attempt > 0) {
        assert(job.runAfterMs >= job.updatedAtMs, "a retry waits at least until it was returned");
        assert(
            job.runAfterMs - job.updatedAtMs <= backoffMs(job.attempt),
            "retry delay is the backoff",
        );
    }
    if (job.state === "leased") {
        assert(
            (job.leaseExpiresAtMs ?? 0) <= nowMs + LEASE_TTL_MS,
            "a lease never runs ahead of the TTL",
        );
    }
}

function check(run: Run): void {
    const jobs = run.store.all();
    assert(jobs.length === run.enqueued.size, "no job is lost or invented");
    const nowMs = run.world.clock.nowUnixMs();
    for (const job of jobs) checkJob(run, job, nowMs);
    for (const job of jobs) {
        if ((job.state === "done" || job.state === "dead") && !run.finished.has(job.id)) {
            run.finished.set(job.id, job.state);
        }
    }
}

export function jobScenario(): Scenario {
    return {
        name: "jobs",
        stepsMax: 400,
        start(world: World) {
            const store = createMemoryJobStore();
            const run: Run = {
                world,
                store,
                deps: { store, clock: world.clock, rng: world.rng },
                epochs: new Map(),
                finished: new Map(),
                enqueued: new Set(),
                held: [],
                keys: new Map(),
            };
            return {
                async step() {
                    const roll = world.rng.nextInt(10);
                    if (roll < 3) await opEnqueue(run);
                    else if (roll < 6) await opLease(run);
                    else if (roll < 9) await opWork(run);
                    else if (world.rng.nextInt(3) === 0) await sweepJobs(run.deps);
                    else world.clock.advance(pick(world, ADVANCES_MS));
                },
                check: () => check(run),
            };
        },
    };
}
