import { z } from "zod";
import { idSchema } from "../ids.ts";
import { judgeLanguageSchema } from "../judging.ts";

// The practice bank (Stage 5, slice 12): public problems anyone signed in may solve outside a contest.
// An allowlist, like the contest problem view: the statement and the limits, never the tests or the checker.

export const practiceItemSchema = z.object({ id: idSchema("tsv"), title: z.string() }).strict();

export const practiceListSchema = z
    .object({ items: z.array(practiceItemSchema), next_cursor: idSchema("tsv").nullable() })
    .strict();

export const practiceListQuerySchema = z
    .object({
        limit: z.coerce.number().int().min(1).max(50).default(20),
        cursor: idSchema("tsv").optional(),
    })
    .strict();

export const practiceProblemSchema = z
    .object({
        id: idSchema("tsv"),
        title: z.string(),
        time_limit_ms: z.number().int().min(1),
        memory_limit_kib: z.number().int().min(1),
        languages: z.array(judgeLanguageSchema),
        statement_html: z.string(),
    })
    .strict();

export const practiceDailySchema = z
    .object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        problem: practiceItemSchema.nullable(),
    })
    .strict();

export const practiceListRequestSchema = z.object({ task_version_id: idSchema("tsv") }).strict();
