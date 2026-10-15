import { z } from "zod";
import { idSchema } from "../ids.ts";

// Customer webhooks (Stage 9). The list of events is closed; adding one is a migration, a name here and a test.
export const WEBHOOK_EVENTS = ["env_run.finished", "credential.issued"] as const;
export const webhookEventSchema = z.enum(WEBHOOK_EVENTS);
// What a delivery can be: a subscribable event, or a test the owner asked for. A test is never something an endpoint subscribes to.
export const WEBHOOK_DELIVERY_TYPES = [...WEBHOOK_EVENTS, "webhook.test"] as const;
export const webhookDeliveryTypeSchema = z.enum(WEBHOOK_DELIVERY_TYPES);

export const createWebhookRequestSchema = z
    .object({
        url: z.string().min(1).max(2000),
        events: z.array(webhookEventSchema).min(1).max(WEBHOOK_EVENTS.length),
    })
    .strict();

export const webhookSchema = z
    .object({
        id: idSchema("whk"),
        url: z.string(),
        events: z.array(webhookEventSchema),
        active: z.boolean(),
        created_at: z.iso.datetime(),
        secret_rotated_at: z.iso.datetime().nullable(),
    })
    .strict();
export const webhooksResponseSchema = z.object({ webhooks: z.array(webhookSchema) }).strict();

// The signing secret is shown exactly once, in the answer that creates or rotates it.
export const webhookSecretSchema = z
    .object({ webhook: webhookSchema, secret: z.string().regex(/^[0-9a-f]{64}$/) })
    .strict();

export const webhookDeliverySchema = z
    .object({
        id: idSchema("whd"),
        event_type: webhookDeliveryTypeSchema,
        state: z.enum(["pending", "delivered", "dead"]),
        attempts: z.number().int().min(0),
        last_status: z.number().int().nullable(),
        last_reason: z.string().nullable(),
        created_at: z.iso.datetime(),
        finished_at: z.iso.datetime().nullable(),
    })
    .strict();
export const webhookDeliveriesResponseSchema = z
    .object({ deliveries: z.array(webhookDeliverySchema) })
    .strict();
