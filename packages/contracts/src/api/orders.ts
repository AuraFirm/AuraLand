import { z } from "zod";
import { idSchema } from "../ids.ts";
import {
    DELIVERY_REVOKE_REASON_CHARS_MAX,
    ORDER_DELIVERY_DAYS_MAX,
    ORDER_INVOICE_CHARS_MAX,
    ORDER_TERMS_CHARS_MAX,
    ORDER_TITLE_CHARS_MAX,
} from "../limits.ts";

// Request and response shapes for orders and deliveries. Responses are allowlists: an order shows its
// terms and the versions in it, a delivery its state and expiry; the manifest and the watermark id are
// added by the delivery endpoints of later slices, never by these.

// No control characters in one-line text, as in the database checks.
const oneLineSchema = (max: number) =>
    z
        .string()
        .normalize("NFC")
        .trim()
        .min(1)
        .max(max)
        .refine((text) => !/\p{Cc}/u.test(text), "contains control characters");

export const orderStateSchema = z.enum(["draft", "placed", "cancelled"]);
export const deliveryStateSchema = z.enum(["pending", "ready", "revoked"]);

export const orderCreateRequestSchema = z
    .object({
        customer_org_id: idSchema("org"),
        title: oneLineSchema(ORDER_TITLE_CHARS_MAX),
        licence_terms: z
            .string()
            .trim()
            .min(1)
            .max(ORDER_TERMS_CHARS_MAX)
            .refine((text) => !text.includes("\0"), "contains a NUL byte"),
        delivery_days: z.number().int().min(1).max(ORDER_DELIVERY_DAYS_MAX),
    })
    .strict();

export const orderItemAddRequestSchema = z.object({ task_version_id: idSchema("tsv") }).strict();
export const orderInvoiceRequestSchema = z
    .object({ invoice_reference: oneLineSchema(ORDER_INVOICE_CHARS_MAX) })
    .strict();
export const deliveryRevokeRequestSchema = z
    .object({ reason: oneLineSchema(DELIVERY_REVOKE_REASON_CHARS_MAX) })
    .strict();

export const orderItemSchema = z
    .object({ task_version_id: idSchema("tsv"), added_at: z.iso.datetime() })
    .strict();

export const deliverySummarySchema = z
    .object({
        id: idSchema("dlv"),
        state: deliveryStateSchema,
        expires_at: z.iso.datetime(),
        revoked_at: z.iso.datetime().nullable(),
    })
    .strict();

export const orderSchema = z
    .object({
        id: idSchema("ord"),
        customer_org_id: idSchema("org"),
        title: z.string(),
        licence_terms: z.string(),
        delivery_days: z.number().int(),
        invoice_reference: z.string().nullable(),
        state: orderStateSchema,
        placed_at: z.iso.datetime().nullable(),
        created_at: z.iso.datetime(),
        // The list carries counts only; the single read carries the items.
        item_count: z.number().int().min(0),
        items: z.array(orderItemSchema).nullable(),
        delivery: deliverySummarySchema.nullable(),
    })
    .strict();
export type OrderBody = z.infer<typeof orderSchema>;

export const ordersResponseSchema = z.object({ orders: z.array(orderSchema) }).strict();
