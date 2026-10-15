import { createHash } from "node:crypto";
import {
    scimTokenCreatedSchema,
    scimTokenSchema,
    scimTokensResponseSchema,
} from "@aura/contracts/api/sso";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import type { Transaction } from "@aura/db/context";
import { postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { Rng } from "../../platform/rng.ts";
import { hasFreshStepUp } from "../../platform/step-up.ts";
import { roleOf } from "../billing/service.ts";

export interface ScimAdminDeps {
    readonly clock: Clock;
    readonly rng: Rng;
    readonly publicOrigin: string;
}

const TOKEN_BYTES = 32;
const row = z.object({
    id: z.string(),
    created_at: z.date(),
    last_used_at: z.date().nullable(),
    revoked_at: z.date().nullable(),
});
const toToken = (r: z.infer<typeof row>) =>
    scimTokenSchema.parse({
        id: encodeId("sct", r.id),
        created_at: r.created_at.toISOString(),
        last_used_at: r.last_used_at?.toISOString() ?? null,
        revoked: r.revoked_at !== null,
    });

// SCIM bearer tokens (Stage 9, slice 6c): owners and administrators of an organization whose plan includes provisioning make them
// (fresh passkey check; the token is shown once and only its hash is kept), list them and revoke them.
export function scimAdminRoutes(deps: ScimAdminDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/orgs/:id/scim-tokens", (c) => handleCreate(c, deps));
    routes.get("/orgs/:id/scim-tokens", handleList);
    routes.delete("/scim-tokens/:id", (c) => handleRevoke(c, deps));
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");

async function allowed(c: Context<AppEnv>, deps: ScimAdminDeps | null, org: string) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return { problem: problemResponse(c, "unauthenticated", "Authentication required") };
    const parsed = idSchema("org").safeParse(org);
    if (!parsed.success)
        return { problem: problemResponse(c, "invalid_request", "Invalid request") };
    const orgId = decodeId("org", parsed.data);
    const role = await roleOf(c.get("tx"), orgId);
    if (role === null) return { problem: notFound(c) };
    if (role !== "owner" && role !== "admin")
        return { problem: problemResponse(c, "forbidden", "Forbidden") };
    if (deps !== null && !hasFreshStepUp(actor.stepUpAtMs, deps.clock.nowUnixMs()))
        return {
            problem: problemResponse(
                c,
                "step_up_required",
                "Confirm with your passkey to continue",
            ),
        };
    return { actor, orgId, orgPublicId: parsed.data };
}

async function handleCreate(c: Context<AppEnv>, deps: ScimAdminDeps) {
    const who = await allowed(c, deps, c.req.param("id") ?? "");
    if ("problem" in who) return who.problem;
    const token = Buffer.from(deps.rng.nextBytes(TOKEN_BYTES)).toString("base64url");
    const tx: Transaction = c.get("tx");
    try {
        const [made] =
            await tx`select create_scim_token(${who.orgId}, ${createHash("sha256").update(token).digest()}, ${new Date(deps.clock.nowUnixMs())}) as id`;
        const id = z.object({ id: z.string() }).parse(made).id;
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: who.actor.userId,
            orgId: null,
            action: "scim.token_created",
            target: who.orgPublicId,
            detail: {},
        });
        const [created] =
            await tx`select id, created_at, last_used_at, revoked_at from scim_tokens where id = ${id}`;
        c.header("Cache-Control", "no-store");
        return c.json(
            scimTokenCreatedSchema.parse({
                token,
                scim_token: toToken(row.parse(created)),
                base_url: `${deps.publicOrigin}/api/scim/v2`,
            }),
            201,
        );
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === "0A000")
            return problemResponse(
                c,
                "plan_limit_reached",
                "Plan limit reached",
                "this plan does not include provisioning",
            );
        if (code === "54000")
            return problemResponse(
                c,
                "conflict",
                "Conflict",
                "too many active tokens: revoke one first",
            );
        if (code === "P0002") return notFound(c);
        throw error;
    }
}

async function handleList(c: Context<AppEnv>) {
    const who = await allowed(c, null, c.req.param("id") ?? "");
    if ("problem" in who) return who.problem;
    const rows = await c.get(
        "tx",
    )`select id, created_at, last_used_at, revoked_at from scim_tokens where org_id = ${who.orgId} order by id desc limit 50`;
    return c.json(
        scimTokensResponseSchema.parse({ tokens: rows.map((r) => toToken(row.parse(r))) }),
    );
}

async function handleRevoke(c: Context<AppEnv>, deps: ScimAdminDeps) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const id = idSchema("sct").safeParse(c.req.param("id"));
    if (!id.success) return problemResponse(c, "invalid_request", "Invalid request");
    if (!hasFreshStepUp(actor.stepUpAtMs, deps.clock.nowUnixMs()))
        return problemResponse(c, "step_up_required", "Confirm with your passkey to continue");
    const tx = c.get("tx");
    try {
        await tx`select revoke_scim_token(${decodeId("sct", id.data)}, ${new Date(deps.clock.nowUnixMs())})`;
    } catch (error) {
        if (postgresErrorCode(error) === "P0002") return notFound(c);
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: null,
        action: "scim.token_revoked",
        target: id.data,
        detail: {},
    });
    return c.body(null, 204);
}
