import { revokedSessionsSchema } from "@aura/contracts/api/account";
import {
    deviceSchema,
    meResponseSchema,
    sessionsResponseSchema,
} from "@aura/contracts/api/identity";
import type { AuditEntryInput } from "@aura/contracts/audit";
import { encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { type Context, Hono } from "hono";
import type { Actor, AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { getMe, listDevices, revokeAllOwnSessions, revokeOwnSession } from "./queries.ts";
import { serializeClearedCookie } from "./rules.ts";
import { needsStepUp } from "./step-up-guard.ts";

export interface IdentityRouteDeps {
    readonly clock: Clock;
    readonly secureCookies: boolean;
}

type UserActor = Extract<Actor, { kind: "user" }>;
type Handler = (c: Context<AppEnv>) => Promise<Response>;

// Routes for a person's own account and sessions (docs/stages/stage-1-plan.md section 6). Each
// handler parses, authorizes, calls a query and serializes through an explicit response schema;
// none holds session logic of its own.
export function identityRoutes(deps: IdentityRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/me", handleMe());
    routes.get("/me/sessions", handleListSessions(deps));
    routes.delete("/me/sessions/:id", handleRevokeSession(deps));
    routes.post("/me/sessions/revoke-others", handleRevokeOthers(deps));
    routes.post("/auth/logout", handleLogout(deps));
    routes.post("/auth/logout-all", handleLogoutAll(deps));
    return routes;
}

// The signed-in user, or null for an anonymous request (the caller answers 401).
function signedIn(c: Context<AppEnv>): UserActor | null {
    const actor = c.get("actor");
    return actor.kind === "user" ? actor : null;
}

const stepUpRequired = (c: Context<AppEnv>) =>
    problemResponse(c, "step_up_required", "Confirm with your passkey to continue");

const unauthenticated = (c: Context<AppEnv>) =>
    problemResponse(c, "unauthenticated", "Authentication required");

const clearCookie = (c: Context<AppEnv>, deps: IdentityRouteDeps) =>
    c.header("Set-Cookie", serializeClearedCookie(deps.secureCookies));

function auditEntry(userId: string, action: string, target: string): AuditEntryInput {
    return { actorKind: "user", actorUserId: userId, orgId: null, action, target };
}

function handleMe(): Handler {
    return async (c) => {
        const actor = signedIn(c);
        if (actor === null) return unauthenticated(c);
        const row = await getMe(c.get("tx"), actor.userId);
        if (row === null) return problemResponse(c, "not_found", "Not found");
        const body = meResponseSchema.parse({
            id: encodeId("usr", row.id),
            email: row.email,
            email_verified: row.email_verified_at !== null,
            handle: row.handle,
            display_name: row.display_name,
            platform_role: row.platform_role,
            deletion_requested_at: row.deletion_requested_at?.toISOString() ?? null,
        });
        return c.json(body);
    };
}

function handleListSessions(deps: IdentityRouteDeps): Handler {
    return async (c) => {
        const actor = signedIn(c);
        if (actor === null) return unauthenticated(c);
        const rows = await listDevices(c.get("tx"), actor.userId, deps.clock.nowUnixMs());
        const items = rows.map((row) =>
            deviceSchema.parse({
                id: encodeId("ses", row.id),
                auth_method: row.auth_method,
                created_at: row.created_at.toISOString(),
                last_seen_at: row.last_seen_at.toISOString(),
                idle_expires_at: row.idle_expires_at.toISOString(),
                absolute_expires_at: row.absolute_expires_at.toISOString(),
                ip_network: row.ip_network,
                user_agent: row.user_agent,
                current: row.id === actor.sessionId,
            }),
        );
        return c.json(sessionsResponseSchema.parse({ items }));
    };
}

function handleRevokeSession(deps: IdentityRouteDeps): Handler {
    return async (c) => {
        const actor = signedIn(c);
        if (actor === null) return unauthenticated(c);
        // Safe parse, never an assertion: this text comes from the outside.
        const parsed = idSchema("ses").safeParse(c.req.param("id"));
        if (!parsed.success) return problemResponse(c, "invalid_request", "Invalid session id");
        const sessionId = parsed.data.slice("ses_".length);
        const tx = c.get("tx");
        const nowMs = deps.clock.nowUnixMs();
        // Ending another device is a change to how the person is signed in; ending this one is not.
        if (sessionId !== actor.sessionId && (await needsStepUp(tx, actor.stepUpAtMs, nowMs))) {
            return stepUpRequired(c);
        }
        if (!(await revokeOwnSession(tx, actor.userId, sessionId, nowMs, "logout"))) {
            return problemResponse(c, "not_found", "Not found");
        }
        await appendAudit(tx, auditEntry(actor.userId, "session.revoked", parsed.data));
        if (sessionId === actor.sessionId) clearCookie(c, deps);
        return c.body(null, 204);
    };
}

// Logging out is idempotent: with no valid session there is nothing to end, but the cookie is
// still cleared so the browser stops sending a stale one.
function handleLogout(deps: IdentityRouteDeps): Handler {
    return async (c) => {
        const actor = signedIn(c);
        clearCookie(c, deps);
        if (actor === null) return c.body(null, 204);
        const tx = c.get("tx");
        await revokeOwnSession(tx, actor.userId, actor.sessionId, deps.clock.nowUnixMs(), "logout");
        const target = encodeId("ses", actor.sessionId);
        await appendAudit(tx, auditEntry(actor.userId, "auth.logout", target));
        return c.body(null, 204);
    };
}

// Signs out every other device and keeps this one.
function handleRevokeOthers(deps: IdentityRouteDeps): Handler {
    return async (c) => {
        const actor = signedIn(c);
        if (actor === null) return unauthenticated(c);
        const tx = c.get("tx");
        const nowMs = deps.clock.nowUnixMs();
        if (await needsStepUp(tx, actor.stepUpAtMs, nowMs)) return stepUpRequired(c);
        const count = await revokeAllOwnSessions(
            tx,
            actor.userId,
            nowMs,
            "logout_all",
            actor.sessionId,
        );
        const target = encodeId("usr", actor.userId);
        await appendAudit(tx, {
            ...auditEntry(actor.userId, "auth.sessions_revoked_others", target),
            detail: { sessions_revoked: count },
        });
        return c.json(revokedSessionsSchema.parse({ revoked: count }));
    };
}

function handleLogoutAll(deps: IdentityRouteDeps): Handler {
    return async (c) => {
        const actor = signedIn(c);
        if (actor === null) return unauthenticated(c);
        const tx = c.get("tx");
        const nowMs = deps.clock.nowUnixMs();
        if (await needsStepUp(tx, actor.stepUpAtMs, nowMs)) return stepUpRequired(c);
        const count = await revokeAllOwnSessions(tx, actor.userId, nowMs, "logout_all");
        const target = encodeId("usr", actor.userId);
        await appendAudit(tx, {
            ...auditEntry(actor.userId, "auth.logout_all", target),
            detail: { sessions_revoked: count },
        });
        clearCookie(c, deps);
        return c.body(null, 204);
    };
}
