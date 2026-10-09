// Goal: the session service must issue unguessable single-use-per-login tokens, store only their
// hash, validate with exact expiry behavior, rotate without a window where both tokens work, cap
// sessions per user by evicting the oldest, and never accept malformed or unknown tokens.
import { describe, expect, it } from "vitest";
import { createMemorySessionStore } from "../../sim/session-store.ts";
import { createFakeClock, createSeededRng } from "../../sim/world.ts";
import {
    SESSION_ABSOLUTE_TIMEOUT_S,
    SESSION_IDLE_TIMEOUT_S_PRIVILEGED,
    SESSIONS_PER_USER_MAX,
} from "./limits.ts";
import {
    createSession,
    hashToken,
    revokeAllSessions,
    revokeSession,
    rotateSession,
    type SessionDeps,
    validateSession,
} from "./service.ts";

const START = 1_800_000_000_000;
const USER = "018f0000-0000-7000-8000-0000000000aa";
const OTHER = "018f0000-0000-7000-8000-0000000000bb";
const SECOND = 1000;

function setup(seed = 1) {
    const clock = createFakeClock(START);
    const store = createMemorySessionStore(() => "active");
    const deps: SessionDeps = { store, clock, rng: createSeededRng(seed) };
    return { clock, store, deps };
}
const login = (deps: SessionDeps, userId = USER, privileged = false) =>
    createSession(deps, { userId, authMethod: "email_link", privileged });

describe("createSession", () => {
    it("returns a 43-character url-safe token whose hash, not the token, is stored", async () => {
        const { deps, store } = setup();
        const { token, session } = await login(deps);
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(session.tokenHash).toBe(hashToken(token));
        expect(JSON.stringify(session)).not.toContain(token);
        expect((await store.findByTokenHash(hashToken(token)))?.record.id).toBe(session.id);
    });

    it("issues a fresh token and id on every login, so a presented value is never reused", async () => {
        const { deps } = setup();
        const issued = await Promise.all([login(deps), login(deps), login(deps)]);
        expect(new Set(issued.map((i) => i.token)).size).toBe(3);
        expect(new Set(issued.map((i) => i.session.id)).size).toBe(3);
    });

    it("records a step-up for passkey logins only", async () => {
        const { deps } = setup();
        const passkey = await createSession(deps, {
            userId: USER,
            authMethod: "passkey",
            privileged: false,
        });
        const link = await login(deps);
        expect(passkey.session.stepUpAtMs).toBe(START);
        expect(link.session.stepUpAtMs).toBeNull();
    });
});

describe("createSession, the per-user cap", () => {
    it("keeps at most the maximum active sessions, evicting the oldest and never the new one", async () => {
        const { deps, clock, store } = setup();
        const first = await login(deps);
        const issued = [first];
        for (let i = 0; i < SESSIONS_PER_USER_MAX; i++) {
            clock.advance(SECOND);
            issued.push(await login(deps));
        }
        expect((await store.listActive(USER, clock.nowUnixMs())).length).toBe(
            SESSIONS_PER_USER_MAX,
        );
        expect((await validateSession(deps, first.token)).ok).toBe(false);
        expect((await validateSession(deps, issued.at(-1)?.token ?? "")).ok).toBe(true);
        const evicted = await store.findByTokenHash(hashToken(first.token));
        expect(evicted?.record.revokedReason).toBe("evicted");
    });

    it("does not count another user's sessions toward the limit", async () => {
        const { deps, clock, store } = setup();
        for (let i = 0; i < SESSIONS_PER_USER_MAX; i++) await login(deps, OTHER);
        await login(deps, USER);
        expect((await store.listActive(OTHER, clock.nowUnixMs())).length).toBe(
            SESSIONS_PER_USER_MAX,
        );
    });
});

describe("validateSession", () => {
    it("accepts a fresh token and refuses malformed, unknown and empty ones without touching the store", async () => {
        const { deps } = setup();
        const { token } = await login(deps);
        expect((await validateSession(deps, token)).ok).toBe(true);
        for (const bad of [
            "",
            "short",
            `${token}x`,
            token.slice(1),
            ` ${token}`,
            `${token.slice(0, 42)}!`,
            "../../etc",
        ]) {
            expect(await validateSession(deps, bad)).toEqual({ ok: false, reason: "malformed" });
        }
        expect(await validateSession(deps, "A".repeat(43))).toEqual({
            ok: false,
            reason: "unknown",
        });
    });

    it("expires exactly at the idle timeout for privileged sessions", async () => {
        // Two independent sessions, because reading a session extends it.
        const justBefore = setup(10);
        const before = await login(justBefore.deps, USER, true);
        justBefore.clock.advance(SESSION_IDLE_TIMEOUT_S_PRIVILEGED * SECOND - 1);
        expect((await validateSession(justBefore.deps, before.token)).ok).toBe(true);

        const exactly = setup(11);
        const at = await login(exactly.deps, USER, true);
        exactly.clock.advance(SESSION_IDLE_TIMEOUT_S_PRIVILEGED * SECOND);
        expect(await validateSession(exactly.deps, at.token)).toEqual({
            ok: false,
            reason: "idle_expired",
        });
    });
});

describe("validateSession, idle and absolute limits", () => {
    it("expires at the idle timeout when unused, and stays alive while used", async () => {
        const { deps, clock } = setup();
        const idle = await login(deps, USER, true);
        const busy = await login(deps, USER, true);
        for (let i = 0; i < 10; i++) {
            clock.advance(10 * 60 * SECOND);
            expect((await validateSession(deps, busy.token)).ok).toBe(true);
        }
        expect(await validateSession(deps, idle.token)).toEqual({
            ok: false,
            reason: "idle_expired",
        });
    });

    it("never outlives the absolute timeout, however active", async () => {
        const { deps, clock } = setup();
        const { token } = await login(deps);
        for (let day = 0; day < 29; day++) {
            clock.advance(24 * 3600 * SECOND);
            expect((await validateSession(deps, token)).ok).toBe(true);
        }
        clock.advance(24 * 3600 * SECOND);
        expect(await validateSession(deps, token)).toEqual({
            ok: false,
            reason: "absolute_expired",
        });
        expect(SESSION_ABSOLUTE_TIMEOUT_S).toBe(30 * 24 * 3600);
    });

    it("refuses sessions of suspended users", async () => {
        const clock = createFakeClock(START);
        const store = createMemorySessionStore((userId) =>
            userId === USER ? "suspended" : "active",
        );
        const deps: SessionDeps = { store, clock, rng: createSeededRng(3) };
        const { token } = await login(deps);
        expect(await validateSession(deps, token)).toEqual({
            ok: false,
            reason: "account_suspended",
        });
    });
});

describe("rotation and revocation", () => {
    it("rotates to a new token, and the old one stops working immediately", async () => {
        const { deps, clock } = setup();
        const old = await createSession(deps, {
            userId: USER,
            authMethod: "passkey",
            privileged: true,
        });
        clock.advance(5 * SECOND);
        const rotated = await rotateSession(deps, old.token);
        expect(rotated.ok).toBe(true);
        if (!rotated.ok) return;
        expect(rotated.token).not.toBe(old.token);
        expect(rotated.session.userId).toBe(USER);
        expect(rotated.session.stepUpAtMs).toBe(old.session.stepUpAtMs);
        expect(await validateSession(deps, old.token)).toEqual({ ok: false, reason: "revoked" });
        expect((await validateSession(deps, rotated.token)).ok).toBe(true);
    });

    it("rotating at the session cap does not log out any other session", async () => {
        // Regression found by the simulation: the new session was created before the old one was
        // revoked, so the count briefly exceeded the cap and an unrelated older session was evicted.
        const { deps, clock, store } = setup();
        const issued = [];
        for (let i = 0; i < SESSIONS_PER_USER_MAX; i++) {
            clock.advance(SECOND);
            issued.push(await login(deps));
        }
        const target = issued[7];
        expect(target).toBeDefined();
        const rotated = await rotateSession(deps, target?.token ?? "");
        expect(rotated.ok).toBe(true);
        expect((await store.listActive(USER, clock.nowUnixMs())).length).toBe(
            SESSIONS_PER_USER_MAX,
        );
        for (const other of issued) {
            if (other === target) continue;
            expect(
                (await validateSession(deps, other.token)).ok,
                "unrelated session survives",
            ).toBe(true);
        }
    });

    it("refuses to rotate an invalid token and creates nothing", async () => {
        const { deps, clock, store } = setup();
        expect(await rotateSession(deps, "A".repeat(43))).toEqual({ ok: false, reason: "unknown" });
        expect(await rotateSession(deps, "bad")).toEqual({ ok: false, reason: "malformed" });
        expect((await store.listActive(USER, clock.nowUnixMs())).length).toBe(0);
    });
});

describe("revocation", () => {
    it("revokes one session, reports whether anything changed, and is idempotent", async () => {
        const { deps } = setup();
        const { token, session } = await login(deps);
        expect(await revokeSession(deps, session.id, "logout")).toBe(true);
        expect(await revokeSession(deps, session.id, "logout")).toBe(false);
        expect(await validateSession(deps, token)).toEqual({ ok: false, reason: "revoked" });
    });

    it("revokes all of a user's sessions except the current one, and leaves other users alone", async () => {
        const { deps } = setup();
        const keep = await login(deps);
        const a = await login(deps);
        const b = await login(deps);
        const other = await login(deps, OTHER);
        expect(await revokeAllSessions(deps, USER, "logout_all", keep.session.id)).toBe(2);
        expect((await validateSession(deps, keep.token)).ok).toBe(true);
        expect((await validateSession(deps, a.token)).ok).toBe(false);
        expect((await validateSession(deps, b.token)).ok).toBe(false);
        expect((await validateSession(deps, other.token)).ok).toBe(true);
    });
});
