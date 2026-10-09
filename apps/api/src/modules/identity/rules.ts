import { assert } from "@aura/contracts/assert";
import {
    SESSION_ABSOLUTE_TIMEOUT_S,
    SESSION_IDLE_TIMEOUT_S_PRIVILEGED,
    SESSION_IDLE_TIMEOUT_S_STANDARD,
    SESSION_TOUCH_INTERVAL_S,
    STEP_UP_FRESH_S,
} from "./limits.ts";

// Pure session rules: no clock, no database, no randomness. Times are unix milliseconds and are
// always passed in, which is what lets the simulation and the database tests share one definition.

export const AUTH_METHODS = ["email_link", "email_code", "passkey", "github", "google"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const REVOKE_REASONS = [
    "logout",
    "logout_all",
    "rotated",
    "evicted",
    "admin",
    "privilege_change",
    "account_suspended",
] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

export type UserStatus = "active" | "suspended";

export interface SessionRecord {
    readonly id: string;
    readonly userId: string;
    readonly tokenHash: string; // lowercase hex of SHA-256; the token itself is never stored
    readonly authMethod: AuthMethod;
    readonly privileged: boolean;
    readonly createdAtMs: number;
    readonly lastSeenAtMs: number;
    readonly idleExpiresAtMs: number;
    readonly absoluteExpiresAtMs: number;
    readonly stepUpAtMs: number | null;
    readonly revokedAtMs: number | null;
    readonly revokedReason: RevokeReason | null;
    // Coarse network (/24 or /48) and browser string, for the "your devices" list; both optional.
    readonly ipNetwork: string | null;
    readonly userAgent: string | null;
}

export type InvalidReason = "revoked" | "account_suspended" | "absolute_expired" | "idle_expired";

export type SessionVerdict =
    | { readonly valid: true; readonly needsTouch: boolean }
    | { readonly valid: false; readonly reason: InvalidReason };

const MS = 1000;

function idleTimeoutMs(privileged: boolean): number {
    return (privileged ? SESSION_IDLE_TIMEOUT_S_PRIVILEGED : SESSION_IDLE_TIMEOUT_S_STANDARD) * MS;
}

export function newSessionTimes(nowMs: number, privileged: boolean) {
    assert(Number.isSafeInteger(nowMs) && nowMs >= 0, "time must be a non-negative integer");
    const absoluteExpiresAtMs = nowMs + SESSION_ABSOLUTE_TIMEOUT_S * MS;
    const idleExpiresAtMs = Math.min(nowMs + idleTimeoutMs(privileged), absoluteExpiresAtMs);
    return { idleExpiresAtMs, absoluteExpiresAtMs };
}

// A session is valid strictly before each expiry. The reasons are checked in a fixed order so the
// same session always reports the same reason, which keeps logs and tests stable.
export function evaluateSession(
    record: SessionRecord,
    userStatus: UserStatus,
    nowMs: number,
): SessionVerdict {
    if (record.revokedAtMs !== null) return { valid: false, reason: "revoked" };
    if (userStatus === "suspended") return { valid: false, reason: "account_suspended" };
    if (nowMs >= record.absoluteExpiresAtMs) return { valid: false, reason: "absolute_expired" };
    if (nowMs >= record.idleExpiresAtMs) return { valid: false, reason: "idle_expired" };
    return {
        valid: true,
        needsTouch: nowMs - record.lastSeenAtMs >= SESSION_TOUCH_INTERVAL_S * MS,
    };
}

// New last-seen and idle-expiry values after activity at `nowMs`. Time never moves backwards, and
// the idle expiry never passes the absolute expiry. For a consistent record (idle expiry =
// last seen + the timeout for its kind) a later touch can only extend the idle expiry.
export function touchedTimes(record: SessionRecord, nowMs: number) {
    return {
        lastSeenAtMs: Math.max(record.lastSeenAtMs, nowMs),
        idleExpiresAtMs: Math.min(
            nowMs + idleTimeoutMs(record.privileged),
            record.absoluteExpiresAtMs,
        ),
    };
}

export function isStepUpFresh(record: SessionRecord, nowMs: number): boolean {
    if (record.stepUpAtMs === null) return false;
    const age = nowMs - record.stepUpAtMs;
    return age >= 0 && age < STEP_UP_FRESH_S * MS;
}

// `activeOldestFirst` includes the session just created, last. Returns the ids to revoke so that
// at most `maximum` remain, always dropping the oldest and never the newest.
export function sessionsToEvict(
    activeOldestFirst: readonly SessionRecord[],
    maximum: number,
): string[] {
    assert(maximum >= 1, "maximum sessions must be at least 1");
    const surplus = activeOldestFirst.length - maximum;
    return surplus > 0 ? activeOldestFirst.slice(0, surplus).map((session) => session.id) : [];
}
