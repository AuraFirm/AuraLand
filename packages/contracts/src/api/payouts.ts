import { z } from "zod";
import { idSchema } from "../ids.ts";

// Contractor payout records. Nothing here moves money; staff record an agreement and, later, that it
// was paid. A contractor sees only their own; platform administrators see all.

export const AMOUNT_MINOR_MAX = 100_000_000_000;

export const payoutCreateRequestSchema = z
    .object({
        contractor_id: idSchema("usr"),
        task_version_id: idSchema("tsv"),
        // Minor units (cents), so no fractions are ever stored or compared.
        amount_minor: z.number().int().min(1).max(AMOUNT_MINOR_MAX),
        currency: z.string().regex(/^[A-Z]{3}$/, "an ISO 4217 code such as USD"),
    })
    .strict();

export const payoutPaidRequestSchema = z
    .object({
        reference: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .refine((text) => !/\p{Cc}/u.test(text), "contains control characters"),
    })
    .strict();

export const payoutSchema = z
    .object({
        id: idSchema("pay"),
        contractor_id: idSchema("usr"),
        task_version_id: idSchema("tsv"),
        amount_minor: z.number().int(),
        currency: z.string(),
        paid_at: z.iso.datetime().nullable(),
        paid_reference: z.string().nullable(),
        created_at: z.iso.datetime(),
    })
    .strict();
export const payoutsResponseSchema = z.object({ payouts: z.array(payoutSchema) }).strict();
