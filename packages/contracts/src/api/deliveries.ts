import { z } from "zod";
import { idSchema } from "../ids.ts";

// What a customer sees of a delivery. Responses are allowlists: the manifest text (for verification),
// its hash, and a per-item summary; never a storage key, the bundle bytes or another customer's data.

// "expired" is derived from the clock; the database keeps pending, ready and revoked.
export const deliveryStatusSchema = z.enum(["pending", "ready", "revoked", "expired"]);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

export const deliveryItemSchema = z
    .object({
        task_version_id: idSchema("tsv"),
        title: z.string(),
        bundle_bytes: z.number().int().min(1),
        bundle_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        validation: z.string(),
    })
    .strict();

export const deliverySchema = z
    .object({
        id: idSchema("dlv"),
        order_id: idSchema("ord"),
        order_title: z.string(),
        status: deliveryStatusSchema,
        expires_at: z.iso.datetime(),
        created_at: z.iso.datetime(),
        // Only the single read of a ready delivery carries these.
        manifest: z.string().nullable(),
        manifest_sha256: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .nullable(),
        items: z.array(deliveryItemSchema).nullable(),
    })
    .strict();
export type DeliveryBody = z.infer<typeof deliverySchema>;

export const deliveriesResponseSchema = z.object({ deliveries: z.array(deliverySchema) }).strict();

export const downloadRequestSchema = z.object({ task_version_id: idSchema("tsv") }).strict();
export const downloadSchema = z
    .object({ url: z.url(), expires_in_s: z.number().int().min(1) })
    .strict();
