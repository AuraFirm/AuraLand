import {
    createWebhookRequestSchema,
    webhookDeliveriesResponseSchema,
    webhookSecretSchema,
    webhooksResponseSchema,
} from "@aura/contracts/api/webhooks";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { Rng } from "../../platform/rng.ts";
import { hasFreshStepUp } from "../../platform/step-up.ts";
import { checkWebhookUrl } from "../../platform/webhook-egress.ts";
import { roleOf } from "../billing/service.ts";
import * as q from "./queries.ts";

export interface WebhookRouteDeps {
    readonly clock: Clock;
    readonly rng: Rng;
}

const NO_DATA_FOUND = "P0002";
const PROGRAM_LIMIT_EXCEEDED = "54000";
const SECRET_BYTES = 32;

// Customer webhooks (Stage 9, slice 5b): the organization's owners and administrators register addresses, rotate secrets and read
// the delivery log. Creating and rotating show a secret, so they need a fresh passkey check. A stranger gets 404; so does a member
// who is not an owner or administrator when asking about one endpoint, because the database answers both the same way.
export function webhookRoutes(deps: WebhookRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/orgs/:id/webhooks", (c) => handleCreate(c, deps));
    routes.get("/orgs/:id/webhooks", handleList);
    routes.post("/webhooks/:id/rotate-secret", (c) => handleRotate(c, deps));
    routes.delete("/webhooks/:id", handleDisable);
    routes.get("/webhooks/:id/deliveries", handleDeliveries);
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");
const invalid = (c: Context<AppEnv>, detail?: string) =>
    problemResponse(c, "invalid_request", "Invalid request", detail);

function user(c: Context<AppEnv>) {
    const actor = c.get("actor");
    return actor.kind === "user"
        ? { actor }
        : { problem: problemResponse(c, "unauthenticated", "Authentication required") };
}

const newSecret = (rng: Rng) => Buffer.from(rng.nextBytes(SECRET_BYTES)).toString("hex");

function translated(c: Context<AppEnv>, error: unknown) {
    const code = postgresErrorCode(error);
    if (code === NO_DATA_FOUND) return notFound(c);
    if (code === PROGRAM_LIMIT_EXCEEDED)
        return problemResponse(
            c,
            "plan_limit_reached",
            "Plan limit reached",
            "this plan has no room for another endpoint",
        );
    throw error;
}

async function handleCreate(c: Context<AppEnv>, deps: WebhookRouteDeps) {
    const who = user(c);
    if ("problem" in who) return who.problem;
    const org = idSchema("org").safeParse(c.req.param("id"));
    const body = createWebhookRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!org.success || !body.success) return invalid(c);
    const checked = checkWebhookUrl(body.data.url);
    if (!checked.ok) return invalid(c, `the address is not allowed: ${checked.reason}`);
    if (!hasFreshStepUp(who.actor.stepUpAtMs, deps.clock.nowUnixMs()))
        return problemResponse(c, "step_up_required", "Confirm with your passkey to continue");
    const orgId = decodeId("org", org.data);
    const tx = c.get("tx");
    const secret = newSecret(deps.rng);
    try {
        const id = await q.createEndpoint(tx, {
            org: orgId,
            url: checked.url.toString(),
            events: [...new Set(body.data.events)],
            secret,
            nowMs: deps.clock.nowUnixMs(),
        });
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: who.actor.userId,
            orgId: null,
            action: "webhook.created",
            target: encodeId("whk", id),
            detail: { events: body.data.events },
        });
        const row = await q.getEndpoint(tx, id);
        if (row === null)
            throw new Error("a webhook endpoint just created is visible to its creator");
        c.header("Cache-Control", "no-store");
        return c.json(webhookSecretSchema.parse({ webhook: q.toWebhook(row), secret }), 201);
    } catch (error) {
        return translated(c, error);
    }
}

async function handleList(c: Context<AppEnv>) {
    const who = user(c);
    if ("problem" in who) return who.problem;
    const org = idSchema("org").safeParse(c.req.param("id"));
    if (!org.success) return invalid(c);
    const orgId = decodeId("org", org.data);
    const tx = c.get("tx");
    const role = await roleOf(tx, orgId);
    if (role === null) return notFound(c);
    if (role !== "owner" && role !== "admin") return problemResponse(c, "forbidden", "Forbidden");
    const rows = await q.listEndpoints(tx, orgId);
    return c.json(webhooksResponseSchema.parse({ webhooks: rows.map(q.toWebhook) }));
}

async function handleRotate(c: Context<AppEnv>, deps: WebhookRouteDeps) {
    const who = user(c);
    if ("problem" in who) return who.problem;
    const id = idSchema("whk").safeParse(c.req.param("id"));
    if (!id.success) return invalid(c);
    if (!hasFreshStepUp(who.actor.stepUpAtMs, deps.clock.nowUnixMs()))
        return problemResponse(c, "step_up_required", "Confirm with your passkey to continue");
    const raw = decodeId("whk", id.data);
    const tx = c.get("tx");
    const secret = newSecret(deps.rng);
    try {
        await q.rotateSecret(tx, raw, secret, deps.clock.nowUnixMs());
    } catch (error) {
        return translated(c, error);
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: who.actor.userId,
        orgId: null,
        action: "webhook.secret_rotated",
        target: id.data,
        detail: {},
    });
    const row = await q.getEndpoint(tx, raw);
    if (row === null) throw new Error("a rotated endpoint is visible to the person who rotated it");
    c.header("Cache-Control", "no-store");
    return c.json(webhookSecretSchema.parse({ webhook: q.toWebhook(row), secret }));
}

async function handleDisable(c: Context<AppEnv>) {
    const who = user(c);
    if ("problem" in who) return who.problem;
    const id = idSchema("whk").safeParse(c.req.param("id"));
    if (!id.success) return invalid(c);
    const tx = c.get("tx");
    try {
        await q.disableEndpoint(tx, decodeId("whk", id.data));
    } catch (error) {
        return translated(c, error);
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: who.actor.userId,
        orgId: null,
        action: "webhook.disabled",
        target: id.data,
        detail: {},
    });
    return c.body(null, 204);
}

async function handleDeliveries(c: Context<AppEnv>) {
    const who = user(c);
    if ("problem" in who) return who.problem;
    const id = idSchema("whk").safeParse(c.req.param("id"));
    if (!id.success) return invalid(c);
    const raw = decodeId("whk", id.data);
    const tx = c.get("tx");
    if ((await q.getEndpoint(tx, raw)) === null) return notFound(c);
    return c.json(
        webhookDeliveriesResponseSchema.parse({ deliveries: await q.listDeliveries(tx, raw) }),
    );
}
