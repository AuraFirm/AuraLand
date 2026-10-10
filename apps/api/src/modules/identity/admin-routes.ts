import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { hasFreshStepUp } from "./authorize.ts";

export interface AdminRouteDeps {
    readonly clock: Clock;
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
