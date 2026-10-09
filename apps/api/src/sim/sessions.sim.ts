import { assert } from "@aura/contracts/assert";
import {
    SESSION_ABSOLUTE_TIMEOUT_S,
    SESSION_IDLE_TIMEOUT_S_PRIVILEGED,
    SESSION_IDLE_TIMEOUT_S_STANDARD,
    SESSION_TOUCH_INTERVAL_S,
    SESSIONS_PER_USER_MAX,
} from "../modules/identity/limits.ts";
import {
    createSession,
    revokeAllSessions,
    revokeSession,
    rotateSession,
    type SessionDeps,
    type SessionStore,
    validateSession,
} from "../modules/identity/service.ts";
import type { Scenario } from "./runner.ts";
import { createMemorySessionStore } from "./session-store.ts";
import type { World } from "./world.ts";

// Goal: drive the session service with random logins, uses, rotations, revocations and passing
// time, and compare every outcome with an independent model of the rules. The model tracks only
// what a person could observe (when a token was issued, last used, or revoked); it does not reuse
// the production rules. Invariants: a revoked, expired or foreign token never validates; a valid
// one always does; every outcome matches the model; the store's list of active sessions equals the
// model's and never exceeds the per-user maximum; rotation invalidates the old token at once.

const USERS = [
    "018f0000-0000-7000-8000-000000000001",
    "018f0000-0000-7000-8000-000000000002",
    "018f0000-0000-7000-8000-000000000003",
] as const;
// Includes jumps just either side of the 30-minute privileged idle timeout and the 60-second touch
// interval, where an off-by-one in either would show.
const ADVANCES_S = [
    1, 30, 59, 60, 61, 300, 1740, 1741, 1799, 1800, 1801, 3600, 86_400, 604_800, 2_592_000,
];
const MS = 1000;

interface Tracked {
    readonly token: string;
    readonly id: string;
    readonly userId: string;
    readonly privileged: boolean;
    readonly createdAtMs: number;
    lastTouchMs: number;
    revoked: boolean;
}

interface Harness {
    readonly world: World;
    readonly deps: SessionDeps;
    readonly store: SessionStore;
    readonly tracked: Tracked[];
    lastOperation: string;
}

// Test-only fault injection: proves the invariants above really catch a broken service.
export type SessionBug = "none" | "rotation_keeps_old_token";

function withBug(store: SessionStore, bug: SessionBug): SessionStore {
    if (bug === "none") return store;
    return {
        ...store,
        revoke: async (id, atMs, reason) =>
            reason === "rotated" ? false : store.revoke(id, atMs, reason),
    };
}

const now = (h: Harness) => h.world.clock.nowUnixMs();
const randomUser = (h: Harness) => USERS[h.world.rng.nextInt(USERS.length)] ?? USERS[0];
const pick = (h: Harness) => h.tracked[h.world.rng.nextInt(Math.max(h.tracked.length, 1))];

// ---- the model ----

function modelValid(t: Tracked, nowMs: number): boolean {
    const idle = t.privileged ? SESSION_IDLE_TIMEOUT_S_PRIVILEGED : SESSION_IDLE_TIMEOUT_S_STANDARD;
    const withinAbsolute = nowMs < t.createdAtMs + SESSION_ABSOLUTE_TIMEOUT_S * MS;
    return !t.revoked && withinAbsolute && nowMs < t.lastTouchMs + idle * MS;
}

// After a login the oldest surplus sessions of that user are revoked, but the session just created
// is never one of them, even when several logins share a millisecond and its id sorts first.
function modelEvict(h: Harness, userId: string, newId: string): void {
    const others = h.tracked
        .filter((t) => t.userId === userId && t.id !== newId && modelValid(t, now(h)))
        .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1));
    const surplus = others.length + 1 - SESSIONS_PER_USER_MAX;
    for (const t of others.slice(0, Math.max(0, surplus))) t.revoked = true;
}

function track(h: Harness, token: string, userId: string, id: string, privileged: boolean): void {
    const at = now(h);
    h.tracked.push({
        token,
        id,
        userId,
        privileged,
        createdAtMs: at,
        lastTouchMs: at,
        revoked: false,
    });
    modelEvict(h, userId, id);
}

// A successful use extends the model's clock only after the touch interval, like the real rule.
function modelUse(h: Harness, t: Tracked): void {
    if (now(h) - t.lastTouchMs >= SESSION_TOUCH_INTERVAL_S * MS) t.lastTouchMs = now(h);
}

// ---- operations ----

async function login(h: Harness, userId: string, privileged: boolean): Promise<void> {
    const made = await createSession(h.deps, { userId, authMethod: "email_link", privileged });
    assert(!h.tracked.some((t) => t.token === made.token), "tokens are never reused");
    track(h, made.token, userId, made.session.id, privileged);
}

async function opCreate(h: Harness): Promise<void> {
    await login(h, randomUser(h), h.world.rng.nextInt(2) === 0);
}

// A burst of logins for one user: enough to hit the per-user maximum and force eviction, which
// ordinary random logins rarely do within one run.
async function opBurst(h: Harness): Promise<void> {
    const userId = randomUser(h);
    const privileged = h.world.rng.nextInt(2) === 0;
    for (let n = 0; n < SESSIONS_PER_USER_MAX + 2; n++) await login(h, userId, privileged);
}

async function opValidate(h: Harness): Promise<void> {
    const t = pick(h);
    if (t === undefined) return;
    const expected = modelValid(t, now(h));
    const result = await validateSession(h.deps, t.token);
    assert(result.ok === expected, `validity matches the model (expected ${expected})`);
    if (result.ok) {
        assert(
            result.session.userId === t.userId,
            "a token only ever opens its own user's session",
        );
        modelUse(h, t);
    } else if (t.revoked) {
        assert(result.reason === "revoked", "a revoked token reports why");
    }
}

async function opValidateUnknown(h: Harness): Promise<void> {
    const result = await validateSession(h.deps, "Z".repeat(43));
    assert(!result.ok && result.reason === "unknown", "an unissued token never validates");
}

async function opRotate(h: Harness): Promise<void> {
    const t = pick(h);
    if (t === undefined) return;
    const expected = modelValid(t, now(h));
    const result = await rotateSession(h.deps, t.token);
    assert(result.ok === expected, "rotation succeeds exactly when the session is valid");
    if (!result.ok) return;
    t.revoked = true;
    track(h, result.token, t.userId, result.session.id, t.privileged);
    assert(!(await validateSession(h.deps, t.token)).ok, "the old token stops working at once");
}

async function opRevoke(h: Harness): Promise<void> {
    const t = pick(h);
    if (t === undefined) return;
    const changed = await revokeSession(h.deps, t.id, "admin");
    assert(changed === !t.revoked, "revoke reports a change exactly once");
    t.revoked = true;
}

async function opRevokeAll(h: Harness): Promise<void> {
    const userId = randomUser(h);
    const keep = h.world.rng.nextInt(2) === 0 ? pick(h) : undefined;
    const keepId = keep !== undefined && keep.userId === userId ? keep.id : null;
    const mine = h.tracked.filter((t) => t.userId === userId && !t.revoked && t.id !== keepId);
    const count = await revokeAllSessions(h.deps, userId, "logout_all", keepId);
    assert(count === mine.length, "revoke-all counts exactly the sessions it changes");
    for (const t of mine) t.revoked = true;
}

async function opAdvance(h: Harness): Promise<void> {
    h.world.clock.advance((ADVANCES_S[h.world.rng.nextInt(ADVANCES_S.length)] ?? 1) * MS);
}

const OPERATIONS: ReadonlyArray<{
    name: string;
    weight: number;
    run: (h: Harness) => Promise<void>;
}> = [
    { name: "create", weight: 22, run: opCreate },
    { name: "burst", weight: 3, run: opBurst },
    { name: "validate", weight: 32, run: opValidate },
    { name: "validate_unknown", weight: 3, run: opValidateUnknown },
    { name: "rotate", weight: 8, run: opRotate },
    { name: "revoke", weight: 8, run: opRevoke },
    { name: "revoke_all", weight: 4, run: opRevokeAll },
    { name: "advance", weight: 20, run: opAdvance },
];
const TOTAL_WEIGHT = OPERATIONS.reduce((sum, operation) => sum + operation.weight, 0);

async function stepOnce(h: Harness): Promise<void> {
    let roll = h.world.rng.nextInt(TOTAL_WEIGHT);
    for (const operation of OPERATIONS) {
        if (roll >= operation.weight) {
            roll -= operation.weight;
            continue;
        }
        h.lastOperation = operation.name;
        try {
            await operation.run(h);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`${operation.name}: ${reason}`);
        }
        return;
    }
}

// The store's view of active sessions must equal the model's, per user.
async function checkInvariants(h: Harness): Promise<void> {
    for (const userId of USERS) {
        const expected = h.tracked.filter((t) => t.userId === userId && modelValid(t, now(h)));
        assert(expected.length <= SESSIONS_PER_USER_MAX, "never more than the maximum active");
        const actual = await h.store.listActive(userId, now(h));
        const where = `after ${h.lastOperation}: store ${actual.length}, model ${expected.length}`;
        assert(actual.length === expected.length, `store and model agree on the count ${where}`);
        const expectedIds = expected.map((t) => t.id).sort();
        const actualIds = actual.map((s) => s.id).sort();
        assert(
            actualIds.join() === expectedIds.join(),
            `same sessions, not just the count ${where}`,
        );
    }
}

export function sessionScenario(bug: SessionBug): Scenario {
    return {
        name: bug === "none" ? "sessions" : `sessions-${bug}`,
        stepsMax: 300,
        start(world) {
            const store = createMemorySessionStore(() => "active");
            const deps: SessionDeps = {
                store: withBug(store, bug),
                clock: world.clock,
                rng: world.rng,
            };
            const h: Harness = { world, deps, store, tracked: [], lastOperation: "start" };
            return { step: () => stepOnce(h), check: () => checkInvariants(h) };
        },
    };
}
