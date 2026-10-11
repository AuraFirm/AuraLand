import { z } from "zod";
import { idSchema } from "../ids.ts";
import {
    judgeLanguageSchema,
    submissionStateSchema,
    testVerdictSchema,
    verdictSchema,
} from "../judging.ts";
import {
    SUBMISSION_PAGE_SIZE_DEFAULT,
    SUBMISSION_PAGE_SIZE_MAX,
    SUBMISSION_SOURCE_BYTES_MAX,
} from "../limits.ts";

// Request and response shapes for submissions. Responses are allowlists: a participant sees their own
// source, verdict and per-test results (test id, verdict, time, memory) but never test data, jury
// answers or checker output for hidden tests.

export const submissionCreateRequestSchema = z
    .object({
        language: judgeLanguageSchema,
        // UTF-8 bytes, not characters, as for statements.
        source: z
            .string()
            .min(1)
            .refine(
                (text) => new TextEncoder().encode(text).length <= SUBMISSION_SOURCE_BYTES_MAX,
                `source is larger than ${SUBMISSION_SOURCE_BYTES_MAX} bytes`,
            )
            .refine((text) => !text.includes("\0"), "source contains a NUL byte"),
    })
    .strict();

export const testResultSchema = z
    .object({
        test_id: z.string(),
        verdict: testVerdictSchema,
        cpu_ms: z.number().int().min(0),
        wall_ms: z.number().int().min(0),
        memory_kib: z.number().int().min(0),
    })
    .strict();

export const submissionSchema = z
    .object({
        id: idSchema("sub"),
        task_version_id: idSchema("tsv"),
        language: judgeLanguageSchema,
        state: submissionStateSchema,
        verdict: verdictSchema.nullable(),
        score: z.number().nullable(),
        created_at: z.iso.datetime(),
        judged_at: z.iso.datetime().nullable(),
        // Only the single read carries the source and the per-test results.
        source: z.string().nullable(),
        tests: z.array(testResultSchema).nullable(),
    })
    .strict();
export type SubmissionItem = z.infer<typeof submissionSchema>;

export const submissionListQuerySchema = z
    .object({
        task_version_id: idSchema("tsv"),
        limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(SUBMISSION_PAGE_SIZE_MAX)
            .default(SUBMISSION_PAGE_SIZE_DEFAULT),
        cursor: idSchema("sub").optional(),
    })
    .strict();

export const submissionsResponseSchema = z
    .object({ items: z.array(submissionSchema), next_cursor: idSchema("sub").nullable() })
    .strict();
