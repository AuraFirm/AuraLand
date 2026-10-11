import { createHash } from "node:crypto";
import { encodeId } from "@aura/contracts/ids";
import {
    enrollRequestSchema,
    enrollResponseSchema,
    nodeHeartbeatRequestSchema,
    nodeHeartbeatResponseSchema,
} from "@aura/contracts/judge-protocol";
import type { Sql } from "@aura/db/client";
import { withRequestContext } from "@aura/db/context";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import type { ObjectStorage } from "../../platform/object-storage.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { RateLimitRule } from "../../platform/rate-limit.ts";
import type { Rng } from "../../platform/rng.ts";
import { consumeRateLimit, refuseRateLimited } from "../../rate-limit-middleware.ts";
import { clientAddress } from "../../request-info.ts";
import { jobRoutes } from "./job-routes.ts";
import { nodeAuth } from "./node-auth.ts";
import { enrollNode, recordHeartbeat } from "./node-queries.ts";

export interface JudgeRouteDeps {
    readonly sql: Sql;
    readonly clock: Clock;
    readonly key: Buffer;
    readonly trustEdge: boolean;
    readonly rng: Rng;
    readonly storage: ObjectStorage;
}

const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;
const ENROLL_BY_ADDRESS: RateLimitRule = { name: "node-enroll:address", max: 10, windowS: 60 };

// The judge-node protocol (docs/kit/06 section 7). Enrollment spends a single-use token; everything
// else needs a signed request (node-auth.ts). Nodes are machines, so there is no cookie, no CSRF
// header and no browser origin involved.
export function judgeRoutes(deps: JudgeRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/enroll", (c) => handleEnroll(c, deps));
    routes.use("/node/*", nodeAuth(deps));
    routes.post("/node/heartbeat", (c) => handleHeartbeat(c, deps));
    routes.route("/", jobRoutes(deps));
    return routes;
}

async function handleEnroll(c: Context<AppEnv>, deps: JudgeRouteDeps) {
    const address = clientAddress(c, deps.trustEdge) ?? "unknown";
    const verdict = await consumeRateLimit(deps, ENROLL_BY_ADDRESS, address);
    if (!verdict.allowed) return refuseRateLimited(c, verdict);
    const body = enrollRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return problemResponse(c, "invalid_request", "Invalid request");
    const result = await withRequestContext(deps.sql, WORKER, (tx) =>
        enrollNode(tx, {
            tokenHash: createHash("sha256").update(body.data.token).digest(),
            name: body.data.name,
            publicKey: Buffer.from(body.data.public_key, "base64url"),
            agentVersion: body.data.agent_version,
            tiers: body.data.tiers,
            nowMs: deps.clock.nowUnixMs(),
        }),
    );
    // A wrong, used or expired token gets one answer, so tokens cannot be probed.
    if (result.kind === "invalid_token")
        return problemResponse(c, "unauthenticated", "Authentication required");
    if (result.kind === "conflict")
        return problemResponse(c, "conflict", "That name or key is already enrolled");
    return c.json(
        enrollResponseSchema.parse({ node_id: encodeId("nod", result.id), state: "enrolled" }),
        201,
    );
}

async function handleHeartbeat(c: Context<AppEnv>, deps: JudgeRouteDeps) {
    const body = nodeHeartbeatRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return problemResponse(c, "invalid_request", "Invalid request");
    const state = await withRequestContext(deps.sql, WORKER, (tx) =>
        recordHeartbeat(tx, c.get("nodeId"), {
            agentVersion: body.data.agent_version,
            canaryOk: body.data.canary_ok,
            nowMs: deps.clock.nowUnixMs(),
        }),
    );
    return c.json(nodeHeartbeatResponseSchema.parse({ state }));
}
