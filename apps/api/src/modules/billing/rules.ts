import type { Entitlements, Feature, Limit } from "@aura/contracts/api/billing";
import { assert } from "@aura/contracts/assert";

// What a plan allows, as pure functions (no I/O). Every feature check in the product goes through these two, so "fails closed"
// is decided in one place.

export function featureEnabled(entitlements: Entitlements, feature: Feature): boolean {
    return entitlements[feature] === true;
}

// `used` is how many the organization already has (or has consumed this month); the next one is allowed only while `used`
// is below the limit. A limit of zero allows none.
export function withinLimit(entitlements: Entitlements, limit: Limit, used: number): boolean {
    assert(Number.isInteger(used) && used >= 0, "usage is a count, never negative");
    const allowed = entitlements[limit];
    assert(Number.isInteger(allowed) && allowed >= 0, "a limit is a non-negative count");
    return used < allowed;
}

// The calendar month (UTC) that contains `nowMs`: [start, end). Usage and limits are counted per month, in UTC, so the answer
// does not depend on where a server or a customer happens to be.
export function monthBoundsUtc(nowMs: number): { startMs: number; endMs: number } {
    assert(Number.isFinite(nowMs) && nowMs >= 0, "a time is a non-negative number of milliseconds");
    const now = new Date(nowMs);
    const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    assert(startMs <= nowMs && nowMs < endMs, "the month contains the time asked about");
    return { startMs, endMs };
}
