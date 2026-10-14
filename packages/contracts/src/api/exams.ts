import { z } from "zod";
import {
    examAssuranceLevelSchema,
    examModeSchema,
    examProblemInputSchema,
    examStateSchema,
    rubricItemSchema,
} from "../exams.ts";
import { idSchema } from "../ids.ts";
import {
    EXAM_DRAFT_BYTES_MAX,
    EXAM_ROSTER_CSV_BYTES_MAX,
    EXAM_TITLE_CHARS_MAX,
} from "../limits.ts";

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

// The candidate's own sitting. The deadline is the server's; the page counts toward it by the server's clock.
export const examSessionSchema = z
    .object({
        exam_id: idSchema("exm"),
        state: z.enum(["invited", "consented", "started", "submitted", "expired"]),
        extra_minutes: z.number().int(),
        consented: z.boolean(),
        consent_text_version: z.number().int().nullable(),
        current_consent_text_version: z.number().int(),
        started_at: z.iso.datetime().nullable(),
        deadline_at: z.iso.datetime().nullable(),
        submitted_at: z.iso.datetime().nullable(),
    })
    .strict();
export type ExamSession = z.infer<typeof examSessionSchema>;

// The wording the candidate consents to, with its version, so the page shows exactly what the server will
// accept consent to.
export const consentTextSchema = z.object({ version: z.number().int(), text: z.string() }).strict();

// One problem as a candidate works on it: an allowlist (statement, limits, languages), never tests or checker.
export const examProblemViewSchema = z
    .object({
        label: z.string(),
        points: z.number().int(),
        title: z.string(),
        time_limit_ms: z.number().int(),
        memory_limit_kib: z.number().int(),
        languages: z.array(z.string()),
        statement_html: z.string(),
    })
    .strict();

// Autosave. The page sends the whole file with an increasing sequence number; the answer says the newest one
// the server holds. A refusal carries a detail the page acts on: "over" (the time is up) or "last:N".
export const draftSaveRequestSchema = z
    .object({
        seq: z.number().int().min(1),
        language: z.string().regex(/^[a-z][a-z0-9_+.-]{0,31}$/),
        // PostgreSQL text cannot hold a NUL, so it is refused here, as a plain bad request.
        content: z
            .string()
            .max(EXAM_DRAFT_BYTES_MAX)
            .refine((text) => !text.includes("\0"), "text contains a NUL byte"),
    })
    .strict();

export const draftSaveResponseSchema = z
    .object({ acked_seq: z.number().int(), deadline_at: z.iso.datetime() })
    .strict();

export const draftsResponseSchema = z
    .object({
        drafts: z.array(
            z
                .object({
                    label: z.string(),
                    seq: z.number().int(),
                    language: z.string(),
                    content: z.string(),
                })
                .strict(),
        ),
    })
    .strict();

// Grading (Stage 6, slice 5b). Staff see every answer with the judge's verdict and the rubric scores; a candidate,
// after release, sees their own points and comments, never the tests.
export const gradingRowSchema = z
    .object({
        session_id: idSchema("exs"),
        email: z.string(),
        name: z.string(),
        session_state: z.string(),
        label: z.string(),
        points: z.number().int(),
        submission_state: z.string().nullable(),
        verdict: z.string().nullable(),
        judge_score: z.number().nullable(),
        auto_points: z.number(),
        rubric_points: z.number(),
        total_points: z.number(),
        rubric: z.array(rubricItemSchema),
        rubric_scores: z.record(z.string(), z.number().int()),
        comment: z.string(),
    })
    .strict();

export const gradingResponseSchema = z.object({ rows: z.array(gradingRowSchema) }).strict();

export const gradeRequestSchema = z
    .object({
        rubric_scores: z.record(
            z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
            z.number().int().min(0).max(1000),
        ),
        comment: z
            .string()
            .max(2000)
            .refine((text) => !text.includes("\0"), "text contains a NUL byte")
            .default(""),
    })
    .strict();

export const answerDetailSchema = z
    .object({
        language: z.string().nullable(),
        source: z.string().nullable(),
        tests: z.array(z.object({ test_id: z.string(), verdict: z.string() }).strict()),
    })
    .strict();

export const examResultSchema = z
    .object({
        exam_id: idSchema("exm"),
        total_points: z.number(),
        max_points: z.number(),
        problems: z.array(
            z
                .object({
                    label: z.string(),
                    points: z.number().int(),
                    auto_points: z.number(),
                    rubric: z.array(
                        z
                            .object({
                                id: z.string(),
                                label: z.string(),
                                max_points: z.number().int(),
                                awarded: z.number().int(),
                            })
                            .strict(),
                    ),
                    comment: z.string(),
                    total_points: z.number(),
                })
                .strict(),
        ),
    })
    .strict();

// The live monitor and the replay (Stage 6, slice 7). Staff only. Signals are counts for a person to look at, not
// findings; the replay is a base text and a chain of small changes with the events of the sitting beside it.
export const monitorRowSchema = z
    .object({
        session_id: idSchema("exs"),
        email: z.string(),
        name: z.string(),
        state: z.string(),
        consented: z.boolean(),
        started_at: z.iso.datetime().nullable(),
        deadline_at: z.iso.datetime().nullable(),
        last_save_at: z.iso.datetime().nullable(),
        saves: z.number().int(),
        problems_started: z.number().int(),
        focus_lost: z.number().int(),
        paste: z.number().int(),
        fullscreen_exit: z.number().int(),
        offline: z.number().int(),
        last_event_at: z.iso.datetime().nullable(),
    })
    .strict();
export const monitorResponseSchema = z.object({ rows: z.array(monitorRowSchema) }).strict();

export const replayStepSchema = z
    .object({
        seq: z.number().int(),
        at: z.iso.datetime(),
        start: z.number().int(),
        remove: z.number().int(),
        insert: z.string(),
        bytes: z.number().int(),
        sha256: z.string(),
    })
    .strict();

export const replaySchema = z
    .object({
        language: z.string(),
        // The text at `base_seq`, which the steps build on; a later page begins at the last seq of the page before.
        base_seq: z.number().int(),
        base: z.string(),
        steps: z.array(replayStepSchema),
        next_from_seq: z.number().int().nullable(),
        events: z.array(
            z
                .object({
                    at: z.iso.datetime(),
                    kind: z.string(),
                    data: z.record(z.string(), z.unknown()),
                })
                .strict(),
        ),
    })
    .strict();

// Similarity between the answers to one problem (Stage 6, slice 8). A signal for staff to read, never shown to
// candidates and never a verdict; the spans are character ranges in each answer's source.
const personRefSchema = z
    .object({ session_id: idSchema("exs"), name: z.string(), email: z.string() })
    .strict();
const spanSchema = z.object({ start: z.number().int(), end: z.number().int() }).strict();
export const similarityResponseSchema = z
    .object({
        label: z.string(),
        answers: z.number().int(),
        pairs: z.array(
            z
                .object({
                    a: personRefSchema,
                    b: personRefSchema,
                    score: z.number(),
                    shared: z.number().int(),
                    spans_a: z.array(spanSchema),
                    spans_b: z.array(spanSchema),
                })
                .strict(),
        ),
    })
    .strict();
