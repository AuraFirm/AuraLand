import { webhookDeliveryTypeSchema } from "@aura/contracts/api/webhooks";
import { encodeId } from "@aura/contracts/ids";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { Clock } from "../../platform/clock.ts";
import { type DeliveryResult, deliverWebhook } from "../../platform/webhook-egress.ts";
import { nextAttemptAtMs, signingSecrets } from "./rules.ts";
import { signatureHeader } from "./signature.ts";

export interface WebhookTickContext {
    readonly clock: Clock;
    readonly inTransaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
    // Sends one delivery; tests replace it, production uses the SSRF-safe client with its strict policy.
    readonly send?: (
        url: string,
        headers: Record<string, string>,
        body: string,
    ) => Promise<DeliveryResult>;
}

export const WEBHOOK_TICK_MS = 5_000;
// At most this many deliveries are taken per pass, and they are sent one after another, so a slow receiver cannot starve the worker.
const BATCH_MAX = 10;

const dueRow = z.object({
    id: z.string(),
    url: z.string(),
    event_type: webhookDeliveryTypeSchema,
    payload: z.record(z.string(), z.unknown()),
    created_at: z.date(),
    attempts: z.number().int(),
    secret_current: z.string(),
    secret_previous: z.string().nullable(),
    secret_rotated_at: z.date().nullable(),
});

const reasonOf = (result: DeliveryResult) =>
    result.outcome === "delivered"
        ? "delivered"
        : result.outcome === "rejected"
          ? `receiver answered ${result.status}`
          : result.reason;
const statusOf = (result: DeliveryResult) =>
    result.outcome === "delivered" || result.outcome === "rejected" ? result.status : null;

// Sends what is due and records each outcome. Returns how many were attempted.
export async function deliverDueWebhooks(context: WebhookTickContext): Promise<number> {
    const send = context.send ?? ((url, headers, body) => deliverWebhook(url, headers, body));
    const due = await context.inTransaction(async (tx) =>
        (
            await tx`select * from claim_due_webhook_deliveries(${new Date(context.clock.nowUnixMs())}, ${BATCH_MAX})`
        ).map((row) => dueRow.parse(row)),
    );
    for (const delivery of due.slice(0, BATCH_MAX)) {
        const body = JSON.stringify(delivery.payload);
        const sentAtMs = context.clock.nowUnixMs();
        const secrets = signingSecrets(
            {
                current: delivery.secret_current,
                previous: delivery.secret_previous,
                rotatedAtMs: delivery.secret_rotated_at?.getTime() ?? null,
            },
            sentAtMs,
        );
        const result = await send(
            delivery.url,
            {
                "content-type": "application/json",
                "user-agent": "AuraLand-Webhooks/1",
                "x-aura-event": delivery.event_type,
                "x-aura-delivery": encodeId("whd", delivery.id),
                "x-aura-signature": signatureHeader(secrets, sentAtMs, body),
            },
            body,
        );
        const finishedMs = context.clock.nowUnixMs();
        const next =
            result.outcome === "delivered"
                ? null
                : nextAttemptAtMs(delivery.created_at.getTime(), finishedMs, delivery.attempts + 1);
        await context.inTransaction(
            (
                tx,
            ) => tx`select record_webhook_attempt(${delivery.id}, ${result.outcome === "delivered"}, ${statusOf(result)}, ${reasonOf(result)},
                ${next === null ? null : new Date(next)}, ${new Date(finishedMs)})`,
        );
    }
    return due.length;
}
