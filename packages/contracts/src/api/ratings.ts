import { z } from "zod";
import { idSchema } from "../ids.ts";

// Public profiles and rating history (Stage 5, slice 10). Only people whose profile is public are
// readable at all; everyone else is a 404, so the response cannot tell "private" from "no such person".

// Written out so the parser is a closed set; a test keeps it equal to RATING_TIERS.
export const RATING_TIER_NAMES = [
    "Newcomer",
    "Apprentice",
    "Adept",
    "Expert",
    "Master",
    "Grandmaster",
    "Legend",
] as const;
export const RATING_TIER_COLORS = [
    "gray",
    "green",
    "teal",
    "blue",
    "violet",
    "orange",
    "red",
] as const;

export const ratingSummarySchema = z
    .object({
        rating: z.number().int(),
        uncertainty: z.number().int().min(0),
        contests: z.number().int().min(1),
        tier: z.enum(RATING_TIER_NAMES),
        color: z.enum(RATING_TIER_COLORS),
        // Still settling: few contests so far.
        provisional: z.boolean(),
    })
    .strict();

export const publicProfileSchema = z
    .object({
        handle: z.string(),
        display_name: z.string(),
        rating: ratingSummarySchema.nullable(),
    })
    .strict();

export const ratingHistoryItemSchema = z
    .object({
        contest_id: idSchema("cst"),
        contest_title: z.string(),
        rank: z.number().int().min(1),
        rating_before: z.number().int(),
        rating_after: z.number().int(),
        change: z.number().int(),
        performance: z.number().int(),
        at: z.iso.datetime(),
    })
    .strict();

export const ratingHistoryQuerySchema = z
    .object({
        limit: z.coerce.number().int().min(1).max(50).default(20),
        cursor: idSchema("cst").optional(),
    })
    .strict();

export const ratingHistorySchema = z
    .object({
        handle: z.string(),
        rating: ratingSummarySchema.nullable(),
        items: z.array(ratingHistoryItemSchema),
        next_cursor: idSchema("cst").nullable(),
    })
    .strict();
