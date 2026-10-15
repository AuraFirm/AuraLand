import { z } from "zod";
import { idSchema } from "../ids.ts";

// Setter revenue share (Stage 9). Amounts are whole minor units of a currency; nothing here is a float.
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export const minorSchema = z.number().int().min(1).max(100_000_000_000);

export const setterTermsRequestSchema = z
    .object({ user_id: idSchema("usr"), share_bps: z.number().int().min(1).max(10_000) })
    .strict();

export const bookRevenueRequestSchema = z
    .object({
        task_version_id: idSchema("tsv"),
        amount_minor: minorSchema,
        currency: currencySchema,
    })
    .strict();

export const createBatchRequestSchema = z
    .object({
        currency: currencySchema,
        minimum_minor: z.number().int().min(1).max(100_000_000_000).default(1),
    })
    .strict();

export const markBatchPaidRequestSchema = z
    .object({
        reference: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[^\p{Cc}]+$/u),
    })
    .strict();

export const batchSchema = z
    .object({
        id: idSchema("pbt"),
        currency: currencySchema,
        state: z.enum(["created", "paid", "cancelled"]),
        total_minor: z.number().int().min(0),
        lines: z.number().int().min(0),
        created_at: z.iso.datetime(),
        paid_at: z.iso.datetime().nullable(),
    })
    .strict();
export const batchesResponseSchema = z.object({ batches: z.array(batchSchema) }).strict();

export const earningsResponseSchema = z
    .object({
        balances: z.array(
            z
                .object({
                    currency: currencySchema,
                    owed_minor: z.number().int(),
                    available_minor: z.number().int(),
                })
                .strict(),
        ),
    })
    .strict();
