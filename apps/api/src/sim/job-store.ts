import { SWEEP_BATCH_MAX } from "../modules/jobs/limits.ts";
import { backoffMs, cleanError, failureOutcome, type JobRecord } from "../modules/jobs/rules.ts";
import type { JobStore } from "../modules/jobs/store.ts";

// An in-memory JobStore for simulation and unit tests. It must behave exactly like the PostgreSQL
// store (modules/jobs/queries.ts); job-store.equivalence.test.ts checks that against a database.

type Jobs = Map<string, JobRecord>;

function replace(jobs: Jobs, id: string, change: Partial<JobRecord>): void {
    const job = jobs.get(id);
    if (job !== undefined) jobs.set(id, { ...job, ...change });
}

const unfinished = (job: JobRecord) => job.state === "ready" || job.state === "leased";
const byId = (a: JobRecord, b: JobRecord) => (a.id < b.id ? -1 : 1);

function sweep(jobs: Jobs, nowMs: number) {
    const expired = [...jobs.values()]
        .filter((j) => j.state === "leased" && (j.leaseExpiresAtMs ?? Infinity) <= nowMs)
        .sort((a, b) => (a.leaseExpiresAtMs ?? 0) - (b.leaseExpiresAtMs ?? 0) || byId(a, b))
        .slice(0, SWEEP_BATCH_MAX);
    let retried = 0;
    let dead = 0;
    for (const job of expired) {
        const release = { leaseOwner: null, leaseExpiresAtMs: null, updatedAtMs: nowMs };
        if (failureOutcome(job.attempt, job.maxAttempts, true) === "retry") {
            const runAfterMs = nowMs + backoffMs(job.attempt);
            replace(jobs, job.id, {
                ...release,
                state: "ready",
                runAfterMs,
                lastError: "lease expired",
            });
            retried++;
        } else {
            const lastError = "lease expired on the last attempt";
            replace(jobs, job.id, { ...release, state: "dead", lastError });
            dead++;
        }
    }
    return { retried, dead };
}

function enqueue(jobs: Jobs, job: Parameters<JobStore["enqueue"]>[0], nowMs: number) {
    if (job.dedupeKey !== null) {
        const twin = [...jobs.values()].find(
            (other) =>
                other.queue === job.queue && other.dedupeKey === job.dedupeKey && unfinished(other),
        );
        if (twin !== undefined) return { id: twin.id, created: false };
    }
    jobs.set(job.id, {
        ...job,
        state: "ready",
        attempt: 0,
        leaseOwner: null,
        leaseEpoch: 0,
        leaseExpiresAtMs: null,
        result: null,
        lastError: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
    });
    return { id: job.id, created: true };
}

function lease(jobs: Jobs, queue: string, owner: string, nowMs: number, ttlMs: number) {
    sweep(jobs, nowMs);
    const best = [...jobs.values()]
        .filter((j) => j.queue === queue && j.state === "ready" && j.runAfterMs <= nowMs)
        .sort((a, b) => a.priority - b.priority || a.runAfterMs - b.runAfterMs || byId(a, b))[0];
    if (best === undefined) return null;
    replace(jobs, best.id, {
        state: "leased",
        attempt: best.attempt + 1,
        leaseOwner: owner,
        leaseEpoch: best.leaseEpoch + 1,
        leaseExpiresAtMs: nowMs + ttlMs,
        updatedAtMs: nowMs,
    });
    return jobs.get(best.id) ?? null;
}

function leasedWith(jobs: Jobs, id: string, epoch: number): JobRecord | null {
    const job = jobs.get(id);
    return job !== undefined && job.state === "leased" && job.leaseEpoch === epoch ? job : null;
}

function fail(jobs: Jobs, input: Parameters<JobStore["fail"]>[0]) {
    const job = leasedWith(jobs, input.id, input.epoch);
    if (job === null) return "stale" as const;
    const release = {
        leaseOwner: null,
        leaseExpiresAtMs: null,
        lastError: cleanError(input.error),
        updatedAtMs: input.nowMs,
    };
    if (failureOutcome(job.attempt, job.maxAttempts, input.retryable) === "retry") {
        const runAfterMs = input.nowMs + backoffMs(job.attempt);
        replace(jobs, job.id, { ...release, state: "ready", runAfterMs });
        return "retried" as const;
    }
    replace(jobs, job.id, { ...release, state: "dead" });
    return "dead" as const;
}

export function createMemoryJobStore(): JobStore & { all(): JobRecord[] } {
    const jobs: Jobs = new Map();
    return {
        all: () => [...jobs.values()],
        enqueue: async (job, nowMs) => enqueue(jobs, job, nowMs),
        lease: async (queue, owner, nowMs, ttlMs) => lease(jobs, queue, owner, nowMs, ttlMs),
        async heartbeat(id, epoch, nowMs, ttlMs) {
            if (leasedWith(jobs, id, epoch) === null) return false;
            replace(jobs, id, { leaseExpiresAtMs: nowMs + ttlMs, updatedAtMs: nowMs });
            return true;
        },
        async complete(id, epoch, result, nowMs) {
            if (leasedWith(jobs, id, epoch) === null) return false;
            const release = { leaseOwner: null, leaseExpiresAtMs: null };
            replace(jobs, id, { ...release, state: "done", result, updatedAtMs: nowMs });
            return true;
        },
        fail: async (input) => fail(jobs, input),
        sweep: async (nowMs) => sweep(jobs, nowMs),
        get: async (id) => jobs.get(id) ?? null,
    };
}
