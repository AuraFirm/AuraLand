import { revokedSessionsSchema } from "@aura/contracts/api/account";
import { platformStatusRequestSchema, platformStatusSchema } from "@aura/contracts/api/status";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import type { Sql } from "@aura/db/client";
import { withRequestContext } from "@aura/db/context";
import { postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { hasFreshStepUp } from "./authorize.ts";
import { createPgSessionStore } from "./queries.ts";

export interface AdminRouteDeps {
    readonly clock: Clock;
    readonly sql: Sql;
}

// PostgreSQL error codes raised by verify_org: not an administrator, and no such organization.
const INSUFFICIENT_PRIVILEGE = "42501";
const NO_DATA_FOUND = "P0002";

// Platform administration. Only platform administrators may call these; everyone else gets the same
// 404 as for a route that does not exist, so the routes do not advertise themselves. The database
// function checks the role again.
export function adminRoutes(deps: AdminRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/admin/orgs/:id/verify", (c) => handleVerify(c, deps));
    routes.post("/admin/users/:id/revoke-sessions", (c) => handleRevokeSessions(c, deps));
    routes.get("/status", handleStatus);
    routes.put("/admin/status", (c) => handleSetStatus(c, deps));
    return routes;
}

async function handleVerify(c: Context<AppEnv>, deps: AdminRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind === "anonymous")
        return problemResponse(c, "unauthenticated", "Authentication required");
    if (actor.kind !== "user" || actor.platformRole !== "admin") {
        return problemResponse(c, "not_found", "Not found");
    }
    const parsed = idSchema("org").safeParse(c.req.param("id"));
    if (!parsed.success) return problemResponse(c, "invalid_request", "Invalid request");
    if (!hasFreshStepUp(actor.stepUpAtMs, deps.clock.nowUnixMs())) {
        return problemResponse(c, "step_up_required", "Confirm with your passkey to continue");
    }
    const orgId = decodeId("org", parsed.data);
    const tx = c.get("tx");
    try {
        await tx`select verify_org(${orgId})`;
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND || code === INSUFFICIENT_PRIVILEGE) {
            return problemResponse(c, "not_found", "Not found");
        }
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId,
        action: "admin.org_verified",
        target: encodeId("org", orgId),
    });
    return c.body(null, 204);
}

// Incident response: end every session of one person (a stolen device, a suspected takeover). The
// person is not told whether the account exists by anyone but an administrator, who already can see it.
async function handleRevokeSessions(c: Context<AppEnv>, deps: AdminRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind === "anonymous")
        return problemResponse(c, "unauthenticated", "Authentication required");
    if (actor.kind !== "user" || actor.platformRole !== "admin") {
        return problemResponse(c, "not_found", "Not found");
    }
    const parsed = idSchema("usr").safeParse(c.req.param("id"));
    if (!parsed.success) return problemResponse(c, "invalid_request", "Invalid request");
    const nowMs = deps.clock.nowUnixMs();
    if (!hasFreshStepUp(actor.stepUpAtMs, nowMs)) {
        return problemResponse(c, "step_up_required", "Confirm with your passkey to continue");
    }
    const targetId = decodeId("usr", parsed.data);
    const revoked = await withRequestContext(
        deps.sql,
        { role: "aura_auth", actorKind: "anonymous", userId: null, orgIds: [] },
        async (tx) => {
            const count = await createPgSessionStore(tx).revokeAllForUser(
                targetId,
                nowMs,
                "admin",
                null,
            );
            await appendAudit(tx, {
                actorKind: "user",
                actorUserId: actor.userId,
                orgId: null,
                action: "admin.sessions_revoked",
                target: parsed.data,
                detail: { count: String(count) },
            });
            return count;
        },
    );
    return c.json(revokedSessionsSchema.parse({ revoked }));
}

const statusRowSchema = z.object({ level: z.string(), message: z.string(), updated_at: z.date() });

// The banner every page may show. Public and short-lived in caches: an incident notice should reach people
// within seconds, and it carries nothing about anyone.
async function handleStatus(c: Context<AppEnv>) {
    const rows = await c.get("tx")`select level, message, updated_at from platform_status limit 1`;
    const row = statusRowSchema.parse(rows[0]);
    c.header("Cache-Control", "public, max-age=0, s-maxage=5");
    return c.json(
        platformStatusSchema.parse({
            level: row.level,
            message: row.message,
            updated_at: row.updated_at.toISOString(),
        }),
    );
}

async function handleSetStatus(c: Context<AppEnv>, deps: AdminRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind === "anonymous")
        return problemResponse(c, "unauthenticated", "Authentication required");
    if (actor.kind !== "user" || actor.platformRole !== "admin") {
        return problemResponse(c, "not_found", "Not found");
    }
    const body = platformStatusRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return problemResponse(c, "invalid_request", "Invalid request");
    const nowMs = deps.clock.nowUnixMs();
    if (!hasFreshStepUp(actor.stepUpAtMs, nowMs)) {
        return problemResponse(c, "step_up_required", "Confirm with your passkey to continue");
    }
    const tx = c.get("tx");
    await tx`select set_platform_status(${body.data.level}, ${body.data.message}, ${new Date(nowMs)})`;
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: null,
        action: "admin.status_set",
        target: "platform_status",
        detail: { level: body.data.level },
    });
    return c.body(null, 204);
}
