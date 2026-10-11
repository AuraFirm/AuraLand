import { assert } from "@aura/contracts/assert";
import { ATTEMPTS_MAX, BACKOFF_FIRST_MS, BACKOFF_MAX_MS } from "./limits.ts";

// Pure rules of the job queue: no I/O, no clock. The store (memory or PostgreSQL) applies them inside
// single atomic operations; the simulation and the equivalence test hold the two stores to the same
// behaviour.

export type JobState = "ready" | "leased" | "done" | "dead";

export interface JobRecord {
    readonly id: string;
    readonly kind: string;
    readonly orgId: string | null;
    readonly payload: unknown;
    readonly queue: string;
    readonly priority: number;
    readonly state: JobState;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly runAfterMs: number;
    readonly leaseOwner: string | null;
    readonly leaseEpoch: number;
    readonly leaseExpiresAtMs: number | null;
    readonly dedupeKey: string | null;
    readonly result: unknown;
    readonly lastError: string | null;
    readonly createdAtMs: number;
    readonly updatedAtMs: number;
}

export interface NewJob {
    readonly id: string;
    readonly kind: string;
    readonly orgId: string | null;
    readonly payload: unknown;
    readonly queue: string;
    readonly priority: number;
    readonly maxAttempts: number;
    readonly runAfterMs: number;
    readonly dedupeKey: string | null;
}

// Delay before attempt number `attemptsMade + 1`: 5 s, 10 s, 20 s, ... capped at 5 minutes.
export function backoffMs(attemptsMade: number): number {
    assert(Number.isInteger(attemptsMade) && attemptsMade >= 1, "at least one attempt was made");
    assert(attemptsMade <= ATTEMPTS_MAX, "attempts are bounded");
    return Math.min(BACKOFF_FIRST_MS * 2 ** (attemptsMade - 1), BACKOFF_MAX_MS);
}

export type FailureOutcome = "retry" | "dead";

// A failed attempt goes back to the queue unless the failure is permanent or attempts are used up.
export function failureOutcome(
    attempt: number,
    maxAttempts: number,
    retryable: boolean,
): FailureOutcome {
    assert(attempt >= 1 && attempt <= maxAttempts, "attempt is within 1..maxAttempts");
    return retryable && attempt < maxAttempts ? "retry" : "dead";
}

// Text from a worker or node is data: bounded, control characters removed, never trusted.
export function cleanError(text: string): string {
    const bounded = text.slice(0, 2000);
    let cleaned = "";
    // Bounded by the slice above.
    for (const character of bounded) {
        const code = character.charCodeAt(0);
        cleaned += code < 0x20 || code === 0x7f ? " " : character;
    }
    return cleaned;
}
