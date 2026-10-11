import type { JobRecord, NewJob } from "./rules.ts";

// Storage behind the queue. Every method is one atomic step, so two workers calling at once cannot
// both win. The memory implementation (sim/job-store.ts) and the PostgreSQL one (queries.ts) must
// behave identically; job-store.equivalence.test.ts checks that.
export interface JobStore {
    // Adds a job unless an unfinished job with the same queue and dedupe key exists; then returns that one.
    enqueue(job: NewJob, nowMs: number): Promise<{ id: string; created: boolean }>;
    // Moves expired leases back to ready (or to dead when attempts are used up), then leases the best
    // ready job: lowest priority number, then earliest run time, then id. Raises the epoch by one.
    lease(queue: string, owner: string, nowMs: number, ttlMs: number): Promise<JobRecord | null>;
    // True only if the job is leased with exactly this epoch.
    heartbeat(id: string, epoch: number, nowMs: number, ttlMs: number): Promise<boolean>;
    // True only if the job is leased with exactly this epoch; then it is done.
    complete(id: string, epoch: number, result: unknown, nowMs: number): Promise<boolean>;
    fail(input: {
        id: string;
        epoch: number;
        error: string;
        retryable: boolean;
        nowMs: number;
    }): Promise<"retried" | "dead" | "stale">;
    // Expired leases only; bounded per call. Also runs inside `lease`.
    sweep(nowMs: number): Promise<{ retried: number; dead: number }>;
    get(id: string): Promise<JobRecord | null>;
}
