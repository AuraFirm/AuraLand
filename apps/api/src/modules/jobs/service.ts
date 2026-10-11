import { assert } from "@aura/contracts/assert";
import { makeUuidV7 } from "@aura/contracts/ids";
import type { Transaction } from "@aura/db/context";
import type { Clock } from "../../platform/clock.ts";
import type { Rng } from "../../platform/rng.ts";
import { ATTEMPTS_DEFAULT, ATTEMPTS_MAX, LEASE_TTL_MS } from "./limits.ts";
import { createPgJobStore } from "./queries.ts";
import type { JobRecord } from "./rules.ts";
import type { JobStore } from "./store.ts";

// Queue use-cases: orchestration only (ids, clock, defaults). The decisions are in rules.ts and the
// atomic steps in the store. Callers that need several steps to be atomic run them in one transaction.

export interface JobDeps {
    readonly store: JobStore;
    readonly clock: Clock;
    readonly rng: Rng;
}

// Queue dependencies bound to one transaction, for callers in other modules (the judge protocol).
export function jobDepsFor(tx: Transaction, clock: Clock, rng: Rng): JobDeps {
    return { store: createPgJobStore(tx), clock, rng };
}

export function getJob(deps: JobDeps, id: string): Promise<JobRecord | null> {
    return deps.store.get(id);
}

export { LEASE_TTL_MS } from "./limits.ts";

export interface EnqueueInput {
    readonly kind: string;
    readonly queue: string;
    readonly payload: unknown;
    readonly orgId?: string | null;
    // 0 is the most urgent, 9 the least; 5 by default.
    readonly priority?: number;
    readonly maxAttempts?: number;
    readonly delayMs?: number;
    // Two unfinished jobs in one queue never share a key; used to make "enqueue" safe to repeat.
    readonly dedupeKey?: string | null;
}

export function enqueueJob(deps: JobDeps, input: EnqueueInput) {
    const nowMs = deps.clock.nowUnixMs();
    const priority = input.priority ?? 5;
    const maxAttempts = input.maxAttempts ?? ATTEMPTS_DEFAULT;
    const delayMs = input.delayMs ?? 0;
    assert(priority >= 0 && priority <= 9, "priority is 0 to 9");
    assert(maxAttempts >= 1 && maxAttempts <= ATTEMPTS_MAX, "attempts within bounds");
    assert(delayMs >= 0, "delay is not negative");
    return deps.store.enqueue(
        {
            id: makeUuidV7(nowMs, deps.rng.nextBytes(10)),
            kind: input.kind,
            orgId: input.orgId ?? null,
            payload: input.payload,
            queue: input.queue,
            priority,
            maxAttempts,
            runAfterMs: nowMs + delayMs,
            dedupeKey: input.dedupeKey ?? null,
        },
        nowMs,
    );
}

export function leaseJob(deps: JobDeps, queue: string, owner: string): Promise<JobRecord | null> {
    return deps.store.lease(queue, owner, deps.clock.nowUnixMs(), LEASE_TTL_MS);
}

export function heartbeatJob(deps: JobDeps, id: string, epoch: number): Promise<boolean> {
    return deps.store.heartbeat(id, epoch, deps.clock.nowUnixMs(), LEASE_TTL_MS);
}

export function completeJob(deps: JobDeps, id: string, epoch: number, result: unknown) {
    return deps.store.complete(id, epoch, result, deps.clock.nowUnixMs());
}

export function failJob(
    deps: JobDeps,
    input: { id: string; epoch: number; error: string; retryable: boolean },
) {
    return deps.store.fail({ ...input, nowMs: deps.clock.nowUnixMs() });
}

export function sweepJobs(deps: JobDeps) {
    return deps.store.sweep(deps.clock.nowUnixMs());
}
