import { createHash } from "node:crypto";
import { assert } from "@aura/contracts/assert";
import { makeUuidV7 } from "@aura/contracts/ids";
import type { Clock } from "../../platform/clock.ts";
import type { Rng } from "../../platform/rng.ts";
import { SESSION_TOKEN_BYTES, SESSION_TOKEN_TEXT_LENGTH, SESSIONS_PER_USER_MAX } from "./limits.ts";
import {
    type AuthMethod,
    evaluateSession,
    type InvalidReason,
    isWellFormedToken,
    newSessionTimes,
    type RevokeReason,
    type SessionRecord,
    sessionsToEvict,
    touchedTimes,
    type UserStatus,
} from "./rules.ts";

// Session use-cases: orchestration only. The decisions live in rules.ts and the storage behind
// `SessionStore`, which has an in-memory implementation for simulation and a PostgreSQL one
// (queries.ts); a test proves the two behave identically. Callers that need several steps to be
// atomic (rotation) run the whole call inside one database transaction.

export interface SessionStore {
    insert(record: SessionRecord): Promise<void>;
    findByTokenHash(
        tokenHash: string,
    ): Promise<{ record: SessionRecord; userStatus: UserStatus } | null>;
    touch(id: string, lastSeenAtMs: number, idleExpiresAtMs: number): Promise<void>;
    // True only if the session was active and is now revoked.
    revoke(id: string, atMs: number, reason: RevokeReason): Promise<boolean>;
    // Revokes every not-yet-revoked session of the user except `exceptId`; returns how many.
    revokeAllForUser(
        userId: string,
        atMs: number,
        reason: RevokeReason,
        exceptId: string | null,
    ): Promise<number>;
    // Not revoked and not expired at `nowMs`, ordered by creation time then id (oldest first).
    listActive(userId: string, nowMs: number): Promise<SessionRecord[]>;
}

export interface SessionDeps {
    readonly store: SessionStore;
    readonly clock: Clock;
    readonly rng: Rng;
}

export interface CreatedSession {
    readonly token: string;
    readonly session: SessionRecord;
}

export type ValidateResult =
    | { readonly ok: true; readonly session: SessionRecord }
    | { readonly ok: false; readonly reason: InvalidReason | "malformed" | "unknown" };

export type RotateResult =
    | ({ readonly ok: true } & CreatedSession)
    | { readonly ok: false; readonly reason: InvalidReason | "malformed" | "unknown" };

const UUID_V7_RANDOM_BYTES = 10;

export function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

export interface NewSessionInput {
    readonly userId: string;
    readonly authMethod: AuthMethod;
    readonly privileged: boolean;
    // Carried over on rotation; by default a passkey login starts with a fresh step-up.
    readonly stepUpAtMs?: number | null;
    readonly ipNetwork?: string | null;
    readonly userAgent?: string | null;
}

const USER_AGENT_LENGTH_MAX = 200; // Matches the database constraint.
const IP_NETWORK_PATTERN = /^[0-9a-f:.]+\/[0-9]{1,3}$/i;

export async function createSession(
    deps: SessionDeps,
    input: NewSessionInput,
): Promise<CreatedSession> {
    const nowMs = deps.clock.nowUnixMs();
    const ipNetwork = input.ipNetwork ?? null;
    const userAgent = input.userAgent ?? null;
    assert(
        ipNetwork === null || IP_NETWORK_PATTERN.test(ipNetwork),
        "ip network looks like a CIDR block",
    );
    assert(
        userAgent === null || userAgent.length <= USER_AGENT_LENGTH_MAX,
        "user agent within its limit",
    );
    const token = Buffer.from(deps.rng.nextBytes(SESSION_TOKEN_BYTES)).toString("base64url");
    assert(token.length === SESSION_TOKEN_TEXT_LENGTH, "token has the expected length");
    const session: SessionRecord = {
        id: makeUuidV7(nowMs, deps.rng.nextBytes(UUID_V7_RANDOM_BYTES)),
        userId: input.userId,
        tokenHash: hashToken(token),
        authMethod: input.authMethod,
        privileged: input.privileged,
        createdAtMs: nowMs,
        lastSeenAtMs: nowMs,
        ...newSessionTimes(nowMs, input.privileged),
        stepUpAtMs:
            input.stepUpAtMs !== undefined
                ? input.stepUpAtMs
                : input.authMethod === "passkey"
                  ? nowMs
                  : null,
        revokedAtMs: null,
        revokedReason: null,
        ipNetwork,
        userAgent,
    };
    await deps.store.insert(session);
    await evictSurplus(deps, session, nowMs);
    return { token, session };
}

// The new session is always last in the list, so it can never be the one evicted, even if an older
// session shares its creation millisecond.
async function evictSurplus(
    deps: SessionDeps,
    created: SessionRecord,
    nowMs: number,
): Promise<void> {
    const active = await deps.store.listActive(created.userId, nowMs);
    const ordered = [...active.filter((other) => other.id !== created.id), created];
    for (const id of sessionsToEvict(ordered, SESSIONS_PER_USER_MAX)) {
        await deps.store.revoke(id, nowMs, "evicted");
    }
}

export async function validateSession(deps: SessionDeps, token: string): Promise<ValidateResult> {
    if (!isWellFormedToken(token)) {
        return { ok: false, reason: "malformed" };
    }
    const found = await deps.store.findByTokenHash(hashToken(token));
    if (found === null) return { ok: false, reason: "unknown" };
    const nowMs = deps.clock.nowUnixMs();
    const verdict = evaluateSession(found.record, found.userStatus, nowMs);
    if (!verdict.valid) return { ok: false, reason: verdict.reason };
    if (!verdict.needsTouch) return { ok: true, session: found.record };
    const times = touchedTimes(found.record, nowMs);
    await deps.store.touch(found.record.id, times.lastSeenAtMs, times.idleExpiresAtMs);
    return { ok: true, session: { ...found.record, ...times } };
}

// Replaces a valid session with a new one for the same user and method, and revokes the old one.
// Use after sign-in and after any change of privilege, so a token seen earlier stops working.
export async function rotateSession(deps: SessionDeps, token: string): Promise<RotateResult> {
    const current = await validateSession(deps, token);
    if (!current.ok) return current;
    // Revoke the old session first. Creating first would briefly exceed the per-user maximum and
    // evict an unrelated session, and a failure between the two steps would leave both usable.
    // With a transaction around the call (the PostgreSQL path) the two steps are atomic anyway.
    await deps.store.revoke(current.session.id, deps.clock.nowUnixMs(), "rotated");
    const created = await createSession(deps, {
        userId: current.session.userId,
        authMethod: current.session.authMethod,
        privileged: current.session.privileged,
        stepUpAtMs: current.session.stepUpAtMs,
        ipNetwork: current.session.ipNetwork,
        userAgent: current.session.userAgent,
    });
    return { ok: true, ...created };
}

export function revokeSession(
    deps: SessionDeps,
    id: string,
    reason: RevokeReason,
): Promise<boolean> {
    return deps.store.revoke(id, deps.clock.nowUnixMs(), reason);
}

export function revokeAllSessions(
    deps: SessionDeps,
    userId: string,
    reason: RevokeReason,
    exceptId: string | null,
): Promise<number> {
    return deps.store.revokeAllForUser(userId, deps.clock.nowUnixMs(), reason, exceptId);
}
