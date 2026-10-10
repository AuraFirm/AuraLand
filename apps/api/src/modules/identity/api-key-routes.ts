import {
    apiKeyCreatedSchema,
    apiKeyCreateRequestSchema,
    apiKeySchema,
    apiKeysResponseSchema,
    keyIntrospectionSchema,
} from "@aura/contracts/api/api-keys";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { CHECK_VIOLATION, postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { Rng } from "../../platform/rng.ts";
import { newApiKey } from "./api-key.ts";
import {
    type ApiKeyRow,
    getApiKey,
    insertApiKey,
    listApiKeys,
    revokeApiKey,
} from "./api-key-queries.ts";
import { authorize, hasFreshStepUp } from "./authorize.ts";

export interface ApiKeyRouteDeps {
    readonly clock: Clock;
    readonly rng: Rng;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Organization API keys: created and revoked by owners and admins (with a fresh passkey check), and
// one introspection route that a key itself can call. Runs in the request transaction.
export function apiKeyRoutes(deps: ApiKeyRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/orgs/:id/api-keys", (c) => handleCreate(c, deps));
    routes.get("/orgs/:id/api-keys", handleList);
    routes.delete("/orgs/:id/api-keys/:keyId", (c) => handleRevoke(c, deps));
    routes.get("/key", handleIntrospect);
    return routes;
}

function keyBody(row: ApiKeyRow) {
    return apiKeySchema.parse({
        id: encodeId("key", row.id),
        name: row.name,
        prefix: row.prefix,
        scopes: row.scopes,
        created_at: row.created_at.toISOString(),
        expires_at: row.expires_at.toISOString(),
        revoked_at: row.revoked_at === null ? null : row.revoked_at.toISOString(),
        last_used_at: row.last_used_at === null ? null : row.last_used_at.toISOString(),
    });
}

interface Managed {
    readonly userId: string;
    readonly orgId: string;
    readonly stepUpAtMs: number | null;
}

// Checks who is calling and whether they may manage this organization's keys. Returns a response
// to send instead when they may not: 401 anonymous, 404 outsider, 403 plain member.
function managerOf(c: Context<AppEnv>): Managed | Response {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const parsed = idSchema("org").safeParse(c.req.param("id"));
    if (!parsed.success) return problemResponse(c, "invalid_request", "Invalid request");
    const orgId = decodeId("org", parsed.data);
    const decision = authorize(actor, { kind: "keys.manage", orgId });
    if (decision.allowed) return { userId: actor.userId, orgId, stepUpAtMs: actor.stepUpAtMs };
    return decision.reason === "not_member"
        ? problemResponse(c, "not_found", "Not found")
        : problemResponse(c, "forbidden", "Forbidden");
}

const STEP_UP_TITLE = "Confirm with your passkey to continue";

async function handleCreate(c: Context<AppEnv>, deps: ApiKeyRouteDeps) {
    const manager = managerOf(c);
    if (manager instanceof Response) return manager;
    const body = apiKeyCreateRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return problemResponse(c, "invalid_request", "Invalid request");
    const nowMs = deps.clock.nowUnixMs();
    if (!hasFreshStepUp(manager.stepUpAtMs, nowMs)) {
        return problemResponse(c, "step_up_required", STEP_UP_TITLE);
    }
    const made = newApiKey(deps.rng);
    const tx = c.get("tx");
    let keyId: string;
    try {
        keyId = await insertApiKey(tx, {
            orgId: manager.orgId,
            name: body.data.name,
            prefix: made.prefix,
            secretHash: made.secretHash,
            scopes: body.data.scopes,
            createdBy: manager.userId,
            expiresAtMs: nowMs + body.data.expires_in_days * DAY_MS,
        });
    } catch (error) {
        if (postgresErrorCode(error) === CHECK_VIOLATION) {
            return problemResponse(
                c,
                "conflict",
                "This organization has the maximum number of live API keys",
            );
        }
        throw error;
    }
    const row = await getApiKey(tx, manager.orgId, keyId);
    if (row === null) throw new Error("a new key is visible to the person who made it");
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: manager.userId,
        orgId: manager.orgId,
        action: "api_key.created",
        target: encodeId("key", keyId),
        detail: { scopes: body.data.scopes.join(",") },
    });
    return c.json(apiKeyCreatedSchema.parse({ ...keyBody(row), key: made.key }), 201);
}

async function handleList(c: Context<AppEnv>) {
    const manager = managerOf(c);
    if (manager instanceof Response) return manager;
    const rows = await listApiKeys(c.get("tx"), manager.orgId);
    return c.json(apiKeysResponseSchema.parse({ items: rows.map(keyBody) }));
}

async function handleRevoke(c: Context<AppEnv>, deps: ApiKeyRouteDeps) {
    const manager = managerOf(c);
    if (manager instanceof Response) return manager;
    const keyParam = idSchema("key").safeParse(c.req.param("keyId"));
    if (!keyParam.success) return problemResponse(c, "invalid_request", "Invalid request");
    if (!hasFreshStepUp(manager.stepUpAtMs, deps.clock.nowUnixMs())) {
        return problemResponse(c, "step_up_required", STEP_UP_TITLE);
    }
    const keyId = decodeId("key", keyParam.data);
    const tx = c.get("tx");
    if (!(await revokeApiKey(tx, manager.orgId, keyId, deps.clock.nowUnixMs()))) {
        return problemResponse(c, "not_found", "Not found");
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: manager.userId,
        orgId: manager.orgId,
        action: "api_key.revoked",
        target: keyParam.data,
    });
    return c.body(null, 204);
}

// What a key can see about itself: which key it is and which organization it acts for.
async function handleIntrospect(c: Context<AppEnv>) {
    const actor = c.get("actor");
    if (actor.kind === "anonymous")
        return problemResponse(c, "unauthenticated", "Authentication required");
    if (actor.kind !== "api_key" || !actor.scopes.includes("org:read")) {
        return problemResponse(c, "forbidden", "Forbidden");
    }
    const rows = await c.get("tx")<
        { id: string; slug: string; name: string; verification_state: "unverified" | "verified" }[]
    >`select id, slug::text as slug, name, verification_state from orgs where id = ${actor.orgId}`;
    const org = rows[0];
    if (org === undefined) return problemResponse(c, "not_found", "Not found");
    return c.json(
        keyIntrospectionSchema.parse({
            key: { id: encodeId("key", actor.keyId), scopes: actor.scopes },
            org: {
                id: encodeId("org", org.id),
                slug: org.slug,
                name: org.name,
                verification_state: org.verification_state,
            },
        }),
    );
}
