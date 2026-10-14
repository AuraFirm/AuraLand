import { z } from "zod";
import { idSchema } from "../ids.ts";
import {
    CLARIFICATION_ANSWER_CHARS_MAX,
    CLARIFICATION_PAGE_SIZE_MAX,
    CLARIFICATION_QUESTION_CHARS_MAX,
} from "../limits.ts";

// Clarifications (Stage 5, slice 7b): plain text between a contestant and the organizers. No Markdown, no
// HTML: the page shows these as text. The asker's identity is never part of a response.

const plainText = (max: number) =>
    z
        .string()
        .min(1)
        .max(max)
        .refine((text) => !text.includes("\0"), "text contains a NUL byte")
        .refine((text) => text.trim().length > 0, "text is empty");

export const clarificationAskRequestSchema = z
    .object({
        // null: about the contest as a whole.
        problem: z
            .string()
            .regex(/^[A-Z][A-Z0-9]{0,2}$/)
            .nullable()
            .default(null),
        question: plainText(CLARIFICATION_QUESTION_CHARS_MAX),
    })
    .strict();

export const clarificationAnswerRequestSchema = z
    .object({
        answer: plainText(CLARIFICATION_ANSWER_CHARS_MAX),
        // true: everyone sees the question and the answer; false: only the asker does.
        public: z.boolean(),
    })
    .strict();

export const clarificationSchema = z
    .object({
        id: idSchema("clr"),
        problem: z.string().nullable(),
        question: z.string(),
        answer: z.string().nullable(),
        public: z.boolean(),
        mine: z.boolean(),
        created_at: z.iso.datetime(),
        answered_at: z.iso.datetime().nullable(),
    })
    .strict();

export const clarificationListQuerySchema = z
    .object({
        limit: z.coerce.number().int().min(1).max(CLARIFICATION_PAGE_SIZE_MAX).default(20),
        cursor: idSchema("clr").optional(),
    })
    .strict();

export const clarificationsResponseSchema = z
    .object({ items: z.array(clarificationSchema), next_cursor: idSchema("clr").nullable() })
    .strict();
