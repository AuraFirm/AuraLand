// Goal: the pure session rules must decide validity exactly at their boundaries, in a fixed order
// of reasons, throttle writes, and evict only the oldest sessions.
import { describe, expect, it } from "vitest";
import {
    SESSION_ABSOLUTE_TIMEOUT_S,
    SESSION_IDLE_TIMEOUT_S_PRIVILEGED,
    SESSION_IDLE_TIMEOUT_S_STANDARD,
    SESSION_TOUCH_INTERVAL_S,
    SESSIONS_PER_USER_MAX,
    STEP_UP_FRESH_S,
} from "./limits.ts";
import {
    evaluateSession,
    isStepUpFresh,
    newSessionTimes,
    type SessionRecord,
    sessionsToEvict,
    touchedTimes,
    withPrivilegedLimit,
} from "./rules.ts";

const T0 = 1_800_000_000_000;
const SECOND = 1000;

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        id: "018f0000-0000-7000-8000-000000000001",
        userId: "018f0000-0000-7000-8000-0000000000aa",
        tokenHash: "00".repeat(32),
        authMethod: "passkey",
        privileged: false,
        createdAtMs: T0,
        lastSeenAtMs: T0,
        idleExpiresAtMs: T0 + SESSION_IDLE_TIMEOUT_S_STANDARD * SECOND,
        absoluteExpiresAtMs: T0 + SESSION_ABSOLUTE_TIMEOUT_S * SECOND,
        stepUpAtMs: null,
        revokedAtMs: null,
        revokedReason: null,
        ipNetwork: null,
        userAgent: null,
        ...overrides,
    };
}

describe("newSessionTimes", () => {
    it("uses the short idle timeout for privileged sessions and the long one otherwise", () => {
        expect(newSessionTimes(T0, true).idleExpiresAtMs - T0).toBe(
            SESSION_IDLE_TIMEOUT_S_PRIVILEGED * SECOND,
        );
        expect(newSessionTimes(T0, false).idleExpiresAtMs - T0).toBe(
            SESSION_IDLE_TIMEOUT_S_STANDARD * SECOND,
        );
        expect(newSessionTimes(T0, false).absoluteExpiresAtMs - T0).toBe(
            SESSION_ABSOLUTE_TIMEOUT_S * SECOND,
        );
    });

    it("never lets the idle expiry pass the absolute expiry", () => {
        const times = newSessionTimes(T0, false);
        expect(times.idleExpiresAtMs).toBeLessThanOrEqual(times.absoluteExpiresAtMs);
    });
});

describe("evaluateSession boundaries", () => {
    const s = record();

    it("is valid up to one millisecond before the idle expiry and invalid exactly at it", () => {
        expect(evaluateSession(s, "active", s.idleExpiresAtMs - 1).valid).toBe(true);
        expect(evaluateSession(s, "active", s.idleExpiresAtMs)).toEqual({
            valid: false,
            reason: "idle_expired",
        });
    });

    it("is invalid exactly at the absolute expiry, even if the idle expiry were later", () => {
        const odd = record({ idleExpiresAtMs: T0 + SESSION_ABSOLUTE_TIMEOUT_S * SECOND + 5 });
        expect(evaluateSession(odd, "active", odd.absoluteExpiresAtMs - 1).valid).toBe(true);
        expect(evaluateSession(odd, "active", odd.absoluteExpiresAtMs)).toEqual({
            valid: false,
            reason: "absolute_expired",
        });
    });

    it("reports reasons in a fixed order: revoked, suspended, absolute, idle", () => {
        const everything = record({ revokedAtMs: T0 + 1, revokedReason: "logout" });
        const late = everything.absoluteExpiresAtMs + 1;
        expect(evaluateSession(everything, "suspended", late)).toEqual({
            valid: false,
            reason: "revoked",
        });
        expect(evaluateSession(s, "suspended", late)).toEqual({
            valid: false,
            reason: "account_suspended",
        });
        expect(evaluateSession(s, "active", late)).toEqual({
            valid: false,
            reason: "absolute_expired",
        });
    });

    it("treats a time before creation as valid, since clocks may differ slightly", () => {
        expect(evaluateSession(s, "active", T0 - 1).valid).toBe(true);
    });
});

describe("touching", () => {
    const s = record({ lastSeenAtMs: T0 });

    it("asks for a write only once the touch interval has passed, to the millisecond", () => {
        const before = T0 + SESSION_TOUCH_INTERVAL_S * SECOND - 1;
        const at = T0 + SESSION_TOUCH_INTERVAL_S * SECOND;
        expect(evaluateSession(s, "active", before)).toEqual({ valid: true, needsTouch: false });
        expect(evaluateSession(s, "active", at)).toEqual({ valid: true, needsTouch: true });
    });

    it("slides the idle expiry forward but never past the absolute expiry", () => {
        const now = T0 + 3600 * SECOND;
        expect(touchedTimes(s, now).idleExpiresAtMs).toBe(
            now + SESSION_IDLE_TIMEOUT_S_STANDARD * SECOND,
        );
        const nearEnd = s.absoluteExpiresAtMs - 10 * SECOND;
        expect(touchedTimes(s, nearEnd).idleExpiresAtMs).toBe(s.absoluteExpiresAtMs);
        expect(touchedTimes(record({ privileged: true }), now).idleExpiresAtMs).toBe(
            now + SESSION_IDLE_TIMEOUT_S_PRIVILEGED * SECOND,
        );
    });

    it("only ever extends a consistent session's idle expiry, for both kinds", () => {
        for (const privileged of [false, true]) {
            const created = newSessionTimes(T0, privileged);
            const base = record({ privileged, ...created });
            for (const later of [0, 1, 59_999, 60_000, 3_600_000, 86_400_000, 40 * 86_400_000]) {
                expect(touchedTimes(base, T0 + later).idleExpiresAtMs).toBeGreaterThanOrEqual(
                    base.idleExpiresAtMs,
                );
            }
        }
    });

    it("never moves the last-seen time backwards", () => {
        expect(touchedTimes(s, T0 - 5 * SECOND).lastSeenAtMs).toBe(T0);
    });
});

describe("withPrivilegedLimit", () => {
    it("pulls the idle deadline in to last activity plus the privileged timeout, never out", () => {
        const idle = SESSION_IDLE_TIMEOUT_S_PRIVILEGED * SECOND;
        const promoted = withPrivilegedLimit(record({ lastSeenAtMs: T0 + 60 * SECOND }));
        expect(promoted.privileged).toBe(true);
        expect(promoted.idleExpiresAtMs).toBe(T0 + 60 * SECOND + idle);
        const soon = record({ idleExpiresAtMs: T0 + SECOND });
        expect(withPrivilegedLimit(soon).idleExpiresAtMs).toBe(T0 + SECOND);
    });

    it("leaves a session that is already privileged exactly as it is", () => {
        const already = record({ privileged: true, idleExpiresAtMs: T0 + 5 });
        expect(withPrivilegedLimit(already)).toBe(already);
    });

    it("makes a session valid strictly before the new deadline and expired from it", () => {
        const promoted = withPrivilegedLimit(record());
        const deadline = T0 + SESSION_IDLE_TIMEOUT_S_PRIVILEGED * SECOND;
        expect(evaluateSession(promoted, "active", deadline - 1).valid).toBe(true);
        expect(evaluateSession(promoted, "active", deadline)).toEqual({
            valid: false,
            reason: "idle_expired",
        });
    });
});

describe("isStepUpFresh", () => {
    it("is fresh strictly inside the window and stale exactly at its end", () => {
        const s = record({ stepUpAtMs: T0 });
        expect(isStepUpFresh(s, T0 + STEP_UP_FRESH_S * SECOND - 1)).toBe(true);
        expect(isStepUpFresh(s, T0 + STEP_UP_FRESH_S * SECOND)).toBe(false);
    });

    it("is never fresh without a step-up, or for a step-up in the future", () => {
        expect(isStepUpFresh(record({ stepUpAtMs: null }), T0)).toBe(false);
        expect(isStepUpFresh(record({ stepUpAtMs: T0 + 10 * SECOND }), T0)).toBe(false);
    });
});

describe("sessionsToEvict", () => {
    const make = (count: number) =>
        Array.from({ length: count }, (_, i) => record({ id: `s${i}` }));

    it("evicts nothing at or below the maximum", () => {
        expect(sessionsToEvict(make(SESSIONS_PER_USER_MAX), SESSIONS_PER_USER_MAX)).toEqual([]);
        expect(sessionsToEvict(make(1), SESSIONS_PER_USER_MAX)).toEqual([]);
    });

    it("evicts the oldest ones, keeping the newest, when over the maximum", () => {
        expect(sessionsToEvict(make(SESSIONS_PER_USER_MAX + 1), SESSIONS_PER_USER_MAX)).toEqual([
            "s0",
        ]);
        expect(sessionsToEvict(make(5), 3)).toEqual(["s0", "s1"]);
    });

    it("rejects a non-positive maximum", () => {
        expect(() => sessionsToEvict(make(2), 0)).toThrow(/maximum/);
    });
});
