import { assert } from "@aura/contracts/assert";

// What the sender of a webhook decides, as pure functions: how a delivery is signed, which secrets still count, and when to try again.

// A receiver rejects a signature whose timestamp is more than five minutes from its clock (docs/kit/06 section 5).
export const SIGNATURE_TOLERANCE_S = 300;
// The secret before a rotation keeps signing for this long, so a receiver can switch over without a gap.
export const SECRET_OVERLAP_MS = 24 * 3600 * 1000;
// A delivery that has not succeeded within this long is given up on.
export const DELIVERY_WINDOW_MS = 24 * 3600 * 1000;
// Delays double from 30 seconds up to four hours: quick retries for a blip, patience for an outage.
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 4 * 3600 * 1000;

export interface EndpointSecrets {
    readonly current: string;
    readonly previous: string | null;
    readonly rotatedAtMs: number | null;
}

// The secrets that sign a delivery now: the current one, and the previous one while the overlap lasts.
export function signingSecrets(secrets: EndpointSecrets, nowMs: number): string[] {
    const overlapping =
        secrets.previous !== null &&
        secrets.rotatedAtMs !== null &&
        nowMs - secrets.rotatedAtMs < SECRET_OVERLAP_MS;
    return overlapping && secrets.previous !== null
        ? [secrets.current, secrets.previous]
        : [secrets.current];
}

// When to try again after an attempt that did not succeed: null means give up. `attemptsMade` counts the attempt just finished.
export function nextAttemptAtMs(
    createdAtMs: number,
    nowMs: number,
    attemptsMade: number,
): number | null {
    assert(attemptsMade >= 1, "this is called after an attempt");
    const deadline = createdAtMs + DELIVERY_WINDOW_MS;
    if (nowMs >= deadline) return null;
    const delay = Math.min(RETRY_FIRST_MS * 2 ** (attemptsMade - 1), RETRY_MAX_MS);
    return Math.min(nowMs + delay, deadline);
}
