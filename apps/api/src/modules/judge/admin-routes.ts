import { createHash, randomBytes } from "node:crypto";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { enrollmentCreatedSchema } from "@aura/contracts/judge-protocol";
import { NODE_ENROLLMENT_TTL_S } from "@aura/contracts/limits";
import { appendAudit } from "@aura/db/audit";
import { postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { hasFreshStepUp } from "../../platform/step-up.ts";

export interface JudgeAdminDeps {
    readonly clock: Clock;
}

const INSUFFICIENT_PRIVILEGE = "42501";
const NO_DATA_FOUND = "P0002";

// Platform administrators enroll and revoke judge nodes. Everyone else gets the 404 they would get
// for a route that does not exist; the database functions check the role again.
export function judgeAdminRoutes(deps: JudgeAdminDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/admin/judge-nodes/enrollments", (c) => handleCreate(c, deps));
    routes.post("/admin/judge-nodes/:id/revoke", (c) => handleRevoke(c, deps));
    return routes;
}

function administrator(c: Context<AppEnv>, deps: JudgeAdminDeps) {
    const actor = c.get("actor");
    if (actor.kind === "anonymous")
        return problemResponse(c, "unauthenticated", "Authentication required");
    if (actor.kind !== "user" || actor.platformRole !== "admin")
        return problemResponse(c, "not_found", "Not found");
    if (!hasFreshStepUp(actor.stepUpAtMs, deps.clock.nowUnixMs())) {
        return problemResponse(c, "step_up_required", "Confirm with your passkey to continue");
    }
    return actor;
}

async function handleCreate(c: Context<AppEnv>, deps: JudgeAdminDeps) {
    const actor = administrator(c, deps);
    if (actor instanceof Response) return actor;
    // 256 random bits; only their SHA-256 is stored, and the token is shown once, here.
    const token = randomBytes(32).toString("base64url");
    const nowMs = deps.clock.nowUnixMs();
    const tx = c.get("tx");
    try {
        await tx`select create_node_enrollment(${createHash("sha256").update(token).digest()}, ${new Date(nowMs)}, ${`${NODE_ENROLLMENT_TTL_S} seconds`}::interval)`;
    } catch (error) {
        if (postgresErrorCode(error) === INSUFFICIENT_PRIVILEGE)
            return problemResponse(c, "not_found", "Not found");
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: null,
        action: "admin.node_enrollment_created",
    });
    c.header("Cache-Control", "no-store");
    return c.json(
        enrollmentCreatedSchema.parse({
            token,
            expires_at: new Date(nowMs + NODE_ENROLLMENT_TTL_S * 1000).toISOString(),
        }),
        201,
    );
}

async function handleRevoke(c: Context<AppEnv>, deps: JudgeAdminDeps) {
    const actor = administrator(c, deps);
    if (actor instanceof Response) return actor;
    const parsed = idSchema("nod").safeParse(c.req.param("id"));
    if (!parsed.success) return problemResponse(c, "invalid_request", "Invalid request");
    const tx = c.get("tx");
    try {
        await tx`select revoke_judge_node(${decodeId("nod", parsed.data)})`;
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND || code === INSUFFICIENT_PRIVILEGE)
            return problemResponse(c, "not_found", "Not found");
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: null,
        action: "admin.node_revoked",
        target: encodeId("nod", decodeId("nod", parsed.data)),
    });
    return c.body(null, 204);
}
