import type { Transaction } from "@aura/db/context";
import { postgresErrorCode } from "@aura/db/errors";
import { z } from "zod";

// SQL for orders and deliveries, run as `aura_app`. Reads go through row-level security (a platform
// administrator sees every order); every write is a database function that checks the platform role
// again, so a route that forgets to check still cannot change anything.

const orderRowSchema = z.object({
    id: z.string(),
    customer_org_id: z.string(),
    title: z.string(),
    licence_terms: z.string(),
    delivery_days: z.number(),
    invoice_reference: z.string().nullable(),
    state: z.enum(["draft", "placed", "cancelled"]),
    placed_at: z.date().nullable(),
    created_at: z.date(),
    item_count: z.coerce.number(),
    delivery_id: z.string().nullable(),
    delivery_state: z.enum(["pending", "ready", "revoked"]).nullable(),
    delivery_expires_at: z.date().nullable(),
    delivery_revoked_at: z.date().nullable(),
});
export type OrderRow = z.infer<typeof orderRowSchema>;

const ORDER_COLUMNS = (tx: Transaction) => tx`
    o.id, o.customer_org_id, o.title, o.licence_terms, o.delivery_days, o.invoice_reference, o.state,
    o.placed_at, o.created_at,
    (select count(*) from order_items i where i.order_id = o.id) as item_count,
    d.id as delivery_id, d.state as delivery_state, d.expires_at as delivery_expires_at,
    d.revoked_at as delivery_revoked_at`;

export async function getOrder(tx: Transaction, orderId: string): Promise<OrderRow | null> {
    const rows = await tx`select ${ORDER_COLUMNS(tx)} from orders o
        left join deliveries d on d.order_id = o.id where o.id = ${orderId}`;
    return rows[0] === undefined ? null : orderRowSchema.parse(rows[0]);
}

// Newest first with the id as a unique tiebreaker; bounded by the caller's limit.
export async function listOrders(tx: Transaction, limit: number): Promise<OrderRow[]> {
    const rows = await tx`select ${ORDER_COLUMNS(tx)} from orders o
        left join deliveries d on d.order_id = o.id
        order by o.created_at desc, o.id desc limit ${limit}`;
    return rows.map((row) => orderRowSchema.parse(row));
}

export async function listOrderItems(tx: Transaction, orderId: string) {
    const rows = await tx`select task_version_id, added_at from order_items
        where order_id = ${orderId} order by added_at, task_version_id limit 100`;
    return rows.map((row) =>
        z.object({ task_version_id: z.string(), added_at: z.date() }).parse(row),
    );
}

const NO_DATA_FOUND = "P0002";
const idRowSchema = z.object({ id: z.string() });

export async function createOrder(
    tx: Transaction,
    input: {
        customerOrgId: string;
        title: string;
        licenceTerms: string;
        deliveryDays: number;
        nowMs: number;
    },
): Promise<string> {
    const rows = await tx`select create_order(${input.customerOrgId}, ${input.title},
        ${input.licenceTerms}, ${input.deliveryDays}, ${new Date(input.nowMs)}) as id`;
    return idRowSchema.parse(rows[0]).id;
}

export async function addOrderItem(
    tx: Transaction,
    orderId: string,
    versionId: string,
    nowMs: number,
) {
    await tx`select add_order_item(${orderId}, ${versionId}, ${new Date(nowMs)})`;
}

export async function removeOrderItem(tx: Transaction, orderId: string, versionId: string) {
    await tx`select remove_order_item(${orderId}, ${versionId})`;
}

export async function setOrderInvoice(
    tx: Transaction,
    orderId: string,
    reference: string,
    nowMs: number,
) {
    await tx`select set_order_invoice(${orderId}, ${reference}, ${new Date(nowMs)})`;
}

export async function cancelOrder(tx: Transaction, orderId: string, nowMs: number) {
    await tx`select cancel_order(${orderId}, ${new Date(nowMs)})`;
}

export async function placeOrder(
    tx: Transaction,
    orderId: string,
    watermark: string,
    nowMs: number,
) {
    const rows = await tx`select place_order(${orderId}, ${watermark}, ${new Date(nowMs)}) as id`;
    return idRowSchema.parse(rows[0]).id;
}

export async function revokeDelivery(
    tx: Transaction,
    deliveryId: string,
    reason: string,
    nowMs: number,
) {
    await tx`select revoke_delivery(${deliveryId}, ${reason}, ${new Date(nowMs)})`;
}

const deliveryRowSchema = z.object({
    id: z.string(),
    order_id: z.string(),
    order_title: z.string(),
    state: z.enum(["pending", "ready", "revoked"]),
    expires_at: z.date(),
    created_at: z.date(),
    manifest: z.string().nullable(),
    manifest_sha256: z.instanceof(Uint8Array).nullable(),
});
export type DeliveryRow = z.infer<typeof deliveryRowSchema>;

// A customer's deliveries as row-level security shows them: their own organization's only.
export async function listDeliveries(tx: Transaction, limit: number): Promise<DeliveryRow[]> {
    const rows = await tx`select d.id, d.order_id, o.title as order_title, d.state, d.expires_at,
        d.created_at, null::text as manifest, null::bytea as manifest_sha256
        from deliveries d join orders o on o.id = d.order_id
        order by d.created_at desc, d.id desc limit ${limit}`;
    return rows.map((row) => deliveryRowSchema.parse(row));
}

export async function getDelivery(
    tx: Transaction,
    deliveryId: string,
): Promise<DeliveryRow | null> {
    const rows = await tx`select d.id, d.order_id, o.title as order_title, d.state, d.expires_at,
        d.created_at, d.manifest, d.manifest_sha256
        from deliveries d join orders o on o.id = d.order_id where d.id = ${deliveryId}`;
    return rows[0] === undefined ? null : deliveryRowSchema.parse(rows[0]);
}

const downloadDecisionSchema = z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), task_org_id: z.string(), bundle_sha256: z.string() }),
    z.object({ status: z.enum(["pending", "revoked", "expired"]) }),
]);
export type DownloadDecision = z.infer<typeof downloadDecisionSchema>;

// Decides and logs in one database step; a null answer means "no such delivery or item for you".
export async function issueDownload(
    tx: Transaction,
    input: {
        deliveryId: string;
        versionId: string;
        address: string | null;
        nowMs: number;
        lifetimeS: number;
    },
): Promise<DownloadDecision | null> {
    try {
        const rows =
            await tx`select issue_delivery_download(${input.deliveryId}, ${input.versionId},
            ${input.address}, ${new Date(input.nowMs)}, ${input.lifetimeS}) as decision`;
        return downloadDecisionSchema.parse(
            z.object({ decision: z.unknown() }).parse(rows[0]).decision,
        );
    } catch (error) {
        if (postgresErrorCode(error) === NO_DATA_FOUND) return null;
        throw error;
    }
}
