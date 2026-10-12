import {
    deliveryRevokeRequestSchema,
    orderCreateRequestSchema,
    orderInvoiceRequestSchema,
    orderItemAddRequestSchema,
    orderSchema,
    ordersResponseSchema,
} from "@aura/contracts/api/orders";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { ORDER_PAGE_SIZE_MAX } from "@aura/contracts/limits";
import { appendAudit } from "@aura/db/audit";
import { postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { Rng } from "../../platform/rng.ts";
import { hasFreshStepUp } from "../../platform/step-up.ts";
import {
    addOrderItem,
    cancelOrder,
    createOrder,
    getOrder,
    listOrderItems,
    listOrders,
    type OrderRow,
    placeOrder,
    removeOrderItem,
    revokeDelivery,
    setOrderInvoice,
} from "./queries.ts";

export interface OrderRouteDeps {
    readonly clock: Clock;
    readonly rng: Rng;
}

const WATERMARK_BYTES = 16;
// Postgres error codes raised by the order functions and guards (see migration 0020).
const INSUFFICIENT_PRIVILEGE = "42501";
const NO_DATA_FOUND = "P0002";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const LIMIT_EXCEEDED = "53400";

// Orders are managed by platform administrators only, with a fresh passkey check on every change.
// Everyone else gets the 404 they would get for a route that does not exist; the database functions
// check the role again.
export function orderRoutes(deps: OrderRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/admin/orders", (c) => write(c, deps, handleCreate));
    routes.get("/admin/orders", (c) => read(c, handleList));
    routes.get("/admin/orders/:id", (c) => read(c, handleGet));
    routes.post("/admin/orders/:id/items", (c) => write(c, deps, handleAddItem));
    routes.delete("/admin/orders/:id/items/:versionId", (c) => write(c, deps, handleRemoveItem));
    routes.put("/admin/orders/:id/invoice", (c) => write(c, deps, handleInvoice));
    routes.post("/admin/orders/:id/place", (c) => write(c, deps, handlePlace));
    routes.post("/admin/orders/:id/cancel", (c) => write(c, deps, handleCancel));
    routes.post("/admin/deliveries/:id/revoke", (c) => write(c, deps, handleRevoke));
    return routes;
}

interface Administrator {
    readonly userId: string;
}
type Handler = (
    c: Context<AppEnv>,
    admin: Administrator,
    deps: OrderRouteDeps,
) => Promise<Response>;

const invalid = (c: Context<AppEnv>, detail?: string) =>
    problemResponse(c, "invalid_request", "Invalid request", detail);
const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");

function administrator(c: Context<AppEnv>): Administrator | Response {
    const actor = c.get("actor");
    if (actor.kind === "anonymous")
        return problemResponse(c, "unauthenticated", "Authentication required");
    if (actor.kind !== "user" || actor.platformRole !== "admin") return notFound(c);
    return { userId: actor.userId };
}

async function read(c: Context<AppEnv>, handler: (c: Context<AppEnv>) => Promise<Response>) {
    const admin = administrator(c);
    return admin instanceof Response ? admin : handler(c);
}

async function write(c: Context<AppEnv>, deps: OrderRouteDeps, handler: Handler) {
    const admin = administrator(c);
    if (admin instanceof Response) return admin;
    const actor = c.get("actor");
    const stepUpAtMs = actor.kind === "user" ? actor.stepUpAtMs : null;
    if (!hasFreshStepUp(stepUpAtMs, deps.clock.nowUnixMs())) {
        return problemResponse(c, "step_up_required", "Confirm with your passkey to continue");
    }
    try {
        return await handler(c, admin, deps);
    } catch (error) {
        return refusal(c, error);
    }
}

// Expected refusals from the database become answers; anything else is a bug and propagates.
function refusal(c: Context<AppEnv>, error: unknown): Response {
    const code = postgresErrorCode(error);
    if (code === INSUFFICIENT_PRIVILEGE || code === NO_DATA_FOUND) return notFound(c);
    if (code === CHECK_VIOLATION || code === UNIQUE_VIOLATION || code === LIMIT_EXCEEDED) {
        return problemResponse(c, "conflict", "The order cannot take this change");
    }
    if (code === FOREIGN_KEY_VIOLATION) return invalid(c, "unknown organization or version");
    throw error;
}

function orderBody(row: OrderRow, items: Awaited<ReturnType<typeof listOrderItems>> | null) {
    return orderSchema.parse({
        id: encodeId("ord", row.id),
        customer_org_id: encodeId("org", row.customer_org_id),
        title: row.title,
        licence_terms: row.licence_terms,
        delivery_days: row.delivery_days,
        invoice_reference: row.invoice_reference,
        state: row.state,
        placed_at: row.placed_at?.toISOString() ?? null,
        created_at: row.created_at.toISOString(),
        item_count: row.item_count,
        items:
            items?.map((item) => ({
                task_version_id: encodeId("tsv", item.task_version_id),
                added_at: item.added_at.toISOString(),
            })) ?? null,
        delivery:
            row.delivery_id === null || row.delivery_state === null
                ? null
                : {
                      id: encodeId("dlv", row.delivery_id),
                      state: row.delivery_state,
                      expires_at: row.delivery_expires_at?.toISOString(),
                      revoked_at: row.delivery_revoked_at?.toISOString() ?? null,
                  },
    });
}

async function singleOrder(c: Context<AppEnv>, orderId: string, status: 200 | 201) {
    const tx = c.get("tx");
    const row = await getOrder(tx, orderId);
    if (row === null) return notFound(c);
    return c.json(orderBody(row, await listOrderItems(tx, orderId)), status);
}

const orderIdOf = (c: Context<AppEnv>, name = "id") => {
    const parsed = idSchema("ord").safeParse(c.req.param(name));
    return parsed.success ? decodeId("ord", parsed.data) : null;
};

async function handleCreate(c: Context<AppEnv>, admin: Administrator, deps: OrderRouteDeps) {
    const body = orderCreateRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const tx = c.get("tx");
    const customer = decodeId("org", body.data.customer_org_id);
    const orderId = await createOrder(tx, {
        customerOrgId: customer,
        title: body.data.title,
        licenceTerms: body.data.licence_terms,
        deliveryDays: body.data.delivery_days,
        nowMs: deps.clock.nowUnixMs(),
    });
    await audit(c, admin, "order.created", orderId, customer);
    return singleOrder(c, orderId, 201);
}

async function audit(
    c: Context<AppEnv>,
    admin: Administrator,
    action: string,
    targetId: string,
    orgId: string | null,
    prefix: "ord" | "dlv" = "ord",
    detail: Record<string, string | number> = {},
) {
    await appendAudit(c.get("tx"), {
        actorKind: "user",
        actorUserId: admin.userId,
        orgId,
        action,
        target: encodeId(prefix, targetId),
        detail,
    });
}

async function handleList(c: Context<AppEnv>) {
    const rows = await listOrders(c.get("tx"), ORDER_PAGE_SIZE_MAX);
    return c.json(ordersResponseSchema.parse({ orders: rows.map((row) => orderBody(row, null)) }));
}

async function handleGet(c: Context<AppEnv>) {
    const orderId = orderIdOf(c);
    return orderId === null ? notFound(c) : singleOrder(c, orderId, 200);
}

async function handleAddItem(c: Context<AppEnv>, admin: Administrator, deps: OrderRouteDeps) {
    const orderId = orderIdOf(c);
    const body = orderItemAddRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (orderId === null || !body.success) return invalid(c);
    const versionId = decodeId("tsv", body.data.task_version_id);
    await addOrderItem(c.get("tx"), orderId, versionId, deps.clock.nowUnixMs());
    await audit(c, admin, "order.item_added", orderId, null, "ord", {
        task_version_id: body.data.task_version_id,
    });
    return singleOrder(c, orderId, 200);
}

async function handleRemoveItem(c: Context<AppEnv>, admin: Administrator) {
    const orderId = orderIdOf(c);
    const version = idSchema("tsv").safeParse(c.req.param("versionId"));
    if (orderId === null || !version.success) return invalid(c);
    await removeOrderItem(c.get("tx"), orderId, decodeId("tsv", version.data));
    await audit(c, admin, "order.item_removed", orderId, null, "ord", {
        task_version_id: version.data,
    });
    return singleOrder(c, orderId, 200);
}

async function handleInvoice(c: Context<AppEnv>, admin: Administrator, deps: OrderRouteDeps) {
    const orderId = orderIdOf(c);
    const body = orderInvoiceRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (orderId === null || !body.success) return invalid(c);
    await setOrderInvoice(
        c.get("tx"),
        orderId,
        body.data.invoice_reference,
        deps.clock.nowUnixMs(),
    );
    await audit(c, admin, "order.invoice_set", orderId, null);
    return singleOrder(c, orderId, 200);
}

async function handlePlace(c: Context<AppEnv>, admin: Administrator, deps: OrderRouteDeps) {
    const orderId = orderIdOf(c);
    if (orderId === null) return invalid(c);
    const watermark = Buffer.from(deps.rng.nextBytes(WATERMARK_BYTES)).toString("hex");
    const deliveryId = await placeOrder(c.get("tx"), orderId, watermark, deps.clock.nowUnixMs());
    await audit(c, admin, "order.placed", orderId, null, "ord", {
        delivery_id: encodeId("dlv", deliveryId),
    });
    return singleOrder(c, orderId, 200);
}

async function handleCancel(c: Context<AppEnv>, admin: Administrator, deps: OrderRouteDeps) {
    const orderId = orderIdOf(c);
    if (orderId === null) return invalid(c);
    await cancelOrder(c.get("tx"), orderId, deps.clock.nowUnixMs());
    await audit(c, admin, "order.cancelled", orderId, null);
    return singleOrder(c, orderId, 200);
}

async function handleRevoke(c: Context<AppEnv>, admin: Administrator, deps: OrderRouteDeps) {
    const parsed = idSchema("dlv").safeParse(c.req.param("id"));
    const body = deliveryRevokeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !body.success) return invalid(c);
    const deliveryId = decodeId("dlv", parsed.data);
    await revokeDelivery(c.get("tx"), deliveryId, body.data.reason, deps.clock.nowUnixMs());
    await audit(c, admin, "delivery.revoked", deliveryId, null, "dlv", {
        reason_chars: body.data.reason.length,
    });
    return c.body(null, 204);
}
