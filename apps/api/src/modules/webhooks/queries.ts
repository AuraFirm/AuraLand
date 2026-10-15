import { webhookDeliverySchema, webhookSchema } from "@aura/contracts/api/webhooks";
import { encodeId } from "@aura/contracts/ids";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for webhook endpoints and deliveries. The secrets are never selected by the application role (column privileges).

const endpointRow = z.object({
    id: z.string(),
    url: z.string(),
    events: z.array(z.string()),
    active: z.boolean(),
    created_at: z.date(),
    secret_rotated_at: z.date().nullable(),
});

export const toWebhook = (row: z.infer<typeof endpointRow>) =>
    webhookSchema.parse({
        id: encodeId("whk", row.id),
        url: row.url,
        events: row.events,
        active: row.active,
        created_at: row.created_at.toISOString(),
        secret_rotated_at: row.secret_rotated_at?.toISOString() ?? null,
    });

export async function createEndpoint(
    tx: Transaction,
    input: { org: string; url: string; events: readonly string[]; secret: string; nowMs: number },
): Promise<string> {
    const [row] =
        await tx`select create_webhook_endpoint(${input.org}, ${input.url}, ${[...input.events]}::text[], ${input.secret}, ${new Date(input.nowMs)}) as id`;
    return z.object({ id: z.string() }).parse(row).id;
}

export async function getEndpoint(tx: Transaction, id: string) {
    const [row] =
        await tx`select id, url, events, active, created_at, secret_rotated_at from webhook_endpoints where id = ${id}`;
    return row === undefined ? null : endpointRow.parse(row);
}

export async function listEndpoints(tx: Transaction, org: string) {
    const rows =
        await tx`select id, url, events, active, created_at, secret_rotated_at from webhook_endpoints
        where org_id = ${org} order by id desc limit 100`;
    return rows.map((row) => endpointRow.parse(row));
}

export async function rotateSecret(
    tx: Transaction,
    id: string,
    secret: string,
    nowMs: number,
): Promise<void> {
    await tx`select rotate_webhook_secret(${id}, ${secret}, ${new Date(nowMs)})`;
}

export async function disableEndpoint(tx: Transaction, id: string): Promise<void> {
    await tx`select disable_webhook_endpoint(${id})`;
}

const deliveryRow = z.object({
    id: z.string(),
    event_type: z.string(),
    state: z.string(),
    attempts: z.number(),
    last_status: z.number().nullable(),
    last_reason: z.string().nullable(),
    created_at: z.date(),
    finished_at: z.date().nullable(),
});

export async function listDeliveries(tx: Transaction, endpoint: string) {
    const rows =
        await tx`select id, event_type, state, attempts, last_status, last_reason, created_at, finished_at
        from webhook_deliveries where endpoint_id = ${endpoint} order by id desc limit 50`;
    return rows.map((raw) => {
        const row = deliveryRow.parse(raw);
        return webhookDeliverySchema.parse({
            id: encodeId("whd", row.id),
            event_type: row.event_type,
            state: row.state,
            attempts: row.attempts,
            last_status: row.last_status,
            last_reason: row.last_reason,
            created_at: row.created_at.toISOString(),
            finished_at: row.finished_at?.toISOString() ?? null,
        });
    });
}
