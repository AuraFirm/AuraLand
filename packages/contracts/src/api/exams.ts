import { z } from "zod";
import {
    examAssuranceLevelSchema,
    examModeSchema,
    examProblemInputSchema,
    examStateSchema,
    rubricItemSchema,
} from "../exams.ts";
import { idSchema } from "../ids.ts";
import { EXAM_ROSTER_CSV_BYTES_MAX, EXAM_TITLE_CHARS_MAX } from "../limits.ts";

// API shapes for exams (Stage 6, slice 2): allowlists, parsed strictly on both sides.

export const examProblemSchema = z
    .object({
        label: z.string(),
        points: z.number().int(),
        auto_percent: z.number().int().min(0).max(100),
        rubric: z.array(rubricItemSchema),
    })
    .strict();

export const examSchema = z
    .object({
        id: idSchema("exm"),
        org_id: idSchema("org"),
        title: z.string(),
        mode: examModeSchema,
        assurance_level: examAssuranceLevelSchema,
        duration_s: z.number().int(),
        window_start: z.iso.datetime(),
        window_end: z.iso.datetime(),
        telemetry_retention_days: z.number().int(),
        state: examStateSchema,
        grades_released_at: z.iso.datetime().nullable(),
        // The problems' labels and points are the staff's until a sitting starts; null for others.
        problems: z.array(examProblemSchema).nullable(),
        // How many people are on the roster; staff only.
        roster_size: z.number().int().nullable(),
        can_manage: z.boolean(),
    })
    .strict();
export type ExamItem = z.infer<typeof examSchema>;

export const examsResponseSchema = z
    .object({ exams: z.array(examSchema), next_cursor: idSchema("exm").nullable() })
    .strict();

export const examListQuerySchema = z
    .object({
        org_id: idSchema("org").optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
        cursor: idSchema("exm").optional(),
    })
    .strict();

export const examUpdateRequestSchema = z
    .object({
        title: z.string().trim().min(1).max(EXAM_TITLE_CHARS_MAX).optional(),
        mode: examModeSchema.optional(),
        duration_s: z.number().int().optional(),
        window_start: z.iso.datetime({ offset: true }).optional(),
        window_end: z.iso.datetime({ offset: true }).optional(),
        telemetry_retention_days: z.number().int().optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, "nothing to change");

export const examProblemAddRequestSchema = examProblemInputSchema;

// The roster arrives as CSV text with a header: email,name[,extra_minutes]. The whole file is validated
// before anything is written, and a refusal lists the lines at fault.
export const rosterUploadRequestSchema = z
    .object({ csv: z.string().min(1).max(EXAM_ROSTER_CSV_BYTES_MAX) })
    .strict();

export const rosterResponseSchema = z
    .object({
        people: z.array(
            z
                .object({
                    email: z.string(),
                    name: z.string(),
                    extra_minutes: z.number().int(),
                })
                .strict(),
        ),
    })
    .strict();

export const rosterCountSchema = z.object({ people: z.number().int() }).strict();
