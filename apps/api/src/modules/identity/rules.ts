import { assert } from "@aura/contracts/assert";
import type { AuthMethod } from "@aura/contracts/identity";
import {
    COOKIE_HEADER_BYTES_MAX,
    CSRF_HEADER_VALUE,
    SESSION_ABSOLUTE_TIMEOUT_S,
    SESSION_IDLE_TIMEOUT_S_PRIVILEGED,
    SESSION_IDLE_TIMEOUT_S_STANDARD,
    SESSION_TOKEN_TEXT_LENGTH,
    SESSION_TOUCH_INTERVAL_S,
    STEP_UP_FRESH_S,
} from "./limits.ts";

// Pure session rules: no clock, no database, no randomness. Times are unix milliseconds and are
// always passed in, which is what lets the simulation and the database tests share one definition.

export type { AuthMethod };

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

// ---- session cookie ----

const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

// A token is exactly 43 url-safe characters. Anything else never reaches the database, and never
// reaches a Set-Cookie header, where a stray ";" or line break could inject attributes.
export function isWellFormedToken(token: string): boolean {
    return token.length === SESSION_TOKEN_TEXT_LENGTH && TOKEN_PATTERN.test(token);
}

// The __Host- prefix makes browsers refuse the cookie unless it is Secure, set from this host, with
// Path=/ and no Domain, so a sibling subdomain cannot plant or overwrite it. It needs Secure, so it
// is used wherever Secure is.
export function sessionCookieName(secure: boolean): string {
    return secure ? "__Host-aura_session" : "aura_session";
}

function cookieAttributes(secure: boolean, maxAgeS: number): string {
    return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
}

export function serializeSessionCookie(token: string, secure: boolean): string {
    assert(isWellFormedToken(token), "token must be 43 url-safe characters");
    return `${sessionCookieName(secure)}=${token}; ${cookieAttributes(secure, SESSION_ABSOLUTE_TIMEOUT_S)}`;
}

export function serializeClearedCookie(secure: boolean): string {
    return `${sessionCookieName(secure)}=; ${cookieAttributes(secure, 0)}`;
}

// Returns the value of the named cookie, or null. A header with the cookie twice is refused rather
// than guessed at: that is the signature of cookie tossing, where another origin plants a second
// cookie of the same name. A value that is not a well-formed token is refused too.
export function readTokenCookie(header: string | undefined, name: string): string | null {
    if (header === undefined || header.length > COOKIE_HEADER_BYTES_MAX) return null;
    const values: string[] = [];
    for (const part of header.split(";")) {
        const separator = part.indexOf("=");
        if (separator === -1) continue;
        if (part.slice(0, separator).trim() === name) values.push(part.slice(separator + 1).trim());
    }
    const [value] = values;
    return values.length === 1 && value !== undefined && isWellFormedToken(value) ? value : null;
}

export function parseSessionCookie(header: string | undefined, secure: boolean): string | null {
    return readTokenCookie(header, sessionCookieName(secure));
}

// ---- cross-site request check ----

export interface CsrfInput {
    readonly method: string;
    readonly origin: string | null;
    readonly secFetchSite: string | null;
    readonly requestHeader: string | null;
    readonly allowedOrigin: string;
}

export type CsrfVerdict =
    | { readonly ok: true }
    | {
          readonly ok: false;
          readonly reason: "missing_header" | "origin_mismatch" | "no_origin" | "cross_site";
      };

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

// Decides whether a state-changing request really came from our own pages. SameSite=Lax cookies
// already stay off most cross-site POSTs; this closes the rest (same-site siblings, old browsers,
// top-level navigations) with three independent signals, all of which must hold.
export function evaluateCsrf(input: CsrfInput): CsrfVerdict {
    if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true };
    if (input.requestHeader !== CSRF_HEADER_VALUE) return { ok: false, reason: "missing_header" };
    if (input.origin !== null && input.origin !== input.allowedOrigin) {
        return { ok: false, reason: "origin_mismatch" };
    }
    if (input.secFetchSite !== null && input.secFetchSite !== "same-origin") {
        return { ok: false, reason: "cross_site" };
    }
    // Without an Origin header the browser must vouch for same-origin itself.
    if (input.origin === null && input.secFetchSite === null)
        return { ok: false, reason: "no_origin" };
    return { ok: true };
}
