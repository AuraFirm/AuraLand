import { createHmac } from "node:crypto";
import { assert } from "@aura/contracts/assert";
import type { Transaction } from "@aura/db/context";
import type { Clock } from "./clock.ts";

// Fixed-window rate limiting for the strict classes (sign-in). Counters live in PostgreSQL so every
// API instance sees the same count. The key is an HMAC of the rule and identifier, so the counter
// table holds no readable address or email. Old windows are not deleted yet; a cleanup job arrives
// with the worker (Stage 3) and nothing reads them meanwhile.

export interface RateLimitRule {
    // Which limit this is, for example "login-start:address". Part of the key.
    readonly name: string;
    readonly max: number;
    readonly windowS: number;
}

export interface CounterStore {
    // Adds one to the counter for this key and window and returns the new count.
    increment(keyHash: string, windowStartMs: number): Promise<number>;
}

export interface RateLimitVerdict {
    readonly allowed: boolean;
    readonly count: number;
    // Whole seconds until the window ends; at least 1.
    readonly retryAfterS: number;
}

export function windowStartMs(nowMs: number, windowS: number): number {
    assert(Number.isSafeInteger(nowMs) && nowMs >= 0, "time must be a non-negative integer");
    assert(
        Number.isSafeInteger(windowS) && windowS >= 1,
        "window must be a whole number of seconds",
    );
    const windowMs = windowS * 1000;
    return nowMs - (nowMs % windowMs);
}

// Length-prefixing the rule name means "a|b" + "c" and "a" + "b|c" can never produce the same input.
export function rateLimitKeyHash(key: Buffer, rule: RateLimitRule, identifier: string): string {
    return createHmac("sha256", key)
        .update(`${rule.name.length}:${rule.name}|${identifier}`)
        .digest("hex");
}

export interface RateLimitDeps {
    readonly store: CounterStore;
    readonly clock: Clock;
    readonly key: Buffer;
}

export async function checkRateLimit(
    deps: RateLimitDeps,
    rule: RateLimitRule,
    identifier: string,
): Promise<RateLimitVerdict> {
    const nowMs = deps.clock.nowUnixMs();
    const start = windowStartMs(nowMs, rule.windowS);
    const count = await deps.store.increment(rateLimitKeyHash(deps.key, rule, identifier), start);
    const remainingMs = start + rule.windowS * 1000 - nowMs;
    return {
        allowed: count <= rule.max,
        count,
        retryAfterS: Math.max(1, Math.ceil(remainingMs / 1000)),
    };
}

export function createMemoryCounterStore(): CounterStore {
    const counts = new Map<string, number>();
    return {
        async increment(keyHash, windowStartMs) {
            const slot = `${keyHash}@${windowStartMs}`;
            const next = (counts.get(slot) ?? 0) + 1;
            counts.set(slot, next);
            return next;
        },
    };
}

// Runs as `aura_auth`. One upsert statement, so concurrent requests each get a distinct count.
export function createPgCounterStore(tx: Transaction): CounterStore {
    return {
        async increment(keyHash, windowStartMs) {
            const rows = await tx<{ count: number }[]>`
                insert into rate_limit_counters (key_hash, window_start, count)
                values (${Buffer.from(keyHash, "hex")}, ${new Date(windowStartMs)}, 1)
                on conflict (key_hash, window_start)
                do update set count = rate_limit_counters.count + 1
                returning count
            `;
            const row = rows[0];
            assert(row !== undefined, "an upsert always returns a row");
            return row.count;
        },
    };
}
