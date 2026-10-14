import { z } from "zod";
import { idSchema } from "./ids.ts";
import {
    EXAM_DURATION_S_MAX,
    EXAM_DURATION_S_MIN,
    EXAM_EXTRA_MINUTES_MAX,
    EXAM_PROBLEMS_MAX,
    EXAM_RUBRIC_ITEMS_MAX,
    EXAM_TITLE_CHARS_MAX,
    EXAM_WINDOW_S_MAX,
    TELEMETRY_BATCH_EVENTS_MAX,
    TELEMETRY_RETENTION_DAYS_DEFAULT,
    TELEMETRY_RETENTION_DAYS_MAX,
} from "./limits.ts";

// Exam vocabulary shared by the control plane, the screens and the simulations (Stage 6, ADR 0032).

// docs/kit/05: AI-free, or AI allowed with the candidate's own use logged.
export const EXAM_MODES = ["ai_free", "ai_allowed_logged"] as const;
export const examModeSchema = z.enum(EXAM_MODES);
export type ExamMode = z.infer<typeof examModeSchema>;

// The exam as a whole. Time moves it from scheduled to open to closed; people publish it (draft to
// scheduled) and release the grades (closed to released).
export const EXAM_STATES = ["draft", "scheduled", "open", "closed", "released"] as const;
export const examStateSchema = z.enum(EXAM_STATES);
export type ExamState = z.infer<typeof examStateSchema>;

// One person's sitting (kit 05 section 7): invited, consented, started, then submitted or expired.
export const SESSION_STATES = ["invited", "consented", "started", "submitted", "expired"] as const;
export const sessionStateSchema = z.enum(SESSION_STATES);
export type SessionState = z.infer<typeof sessionStateSchema>;

// Assurance 1 is what Stage 6 builds: a signed-in account, consent, and consent-gated telemetry. Levels 2
// and 3 (supervised, proctored) are not built and the contract refuses them rather than pretend.
export const examAssuranceLevelSchema = z.literal(1);

// A human decides integrity cases (kit 05); a flag is evidence for them, never a verdict.
export const INTEGRITY_STATES = [
    "unreviewed",
    "clear",
    "needs_review",
    "confirmed",
    "dismissed",
] as const;
export const integrityStateSchema = z.enum(INTEGRITY_STATES);

// Telemetry is a closed list. Nothing here carries what a person typed beyond the code itself (edits are
// part of the answer), no screen, audio or video. A kind outside the list is refused, so a new kind is a
// reviewed change to this file and to the privacy documents.
export const TELEMETRY_KINDS = [
    "focus_lost",
    "focus_gained",
    "fullscreen_exit",
    "paste",
    "copy",
    "cut",
    "edit",
    "run",
    "offline",
    "online",
] as const;
export const telemetryKindSchema = z.enum(TELEMETRY_KINDS);
export type TelemetryKind = z.infer<typeof telemetryKindSchema>;

// Partial credit: a problem's points are split between what the judge awards and what a person grades by
// rubric. auto_percent of the points follow the judge's score; the rest are the rubric items.
export const rubricItemSchema = z
    .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
        label: z.string().trim().min(1).max(200),
        max_points: z.number().int().min(1).max(1000),
    })
    .strict();

export const examProblemInputSchema = z
    .object({
        label: z.string().regex(/^[A-Z][A-Z0-9]{0,2}$/),
        task_version_id: z.string().min(1),
        points: z.number().int().min(1).max(1000),
        auto_percent: z.number().int().min(0).max(100),
        rubric: z.array(rubricItemSchema).max(EXAM_RUBRIC_ITEMS_MAX).default([]),
    })
    .strict()
    .superRefine((problem, context) => {
        const manualPoints = (problem.points * (100 - problem.auto_percent)) / 100;
        const rubricPoints = problem.rubric.reduce((sum, item) => sum + item.max_points, 0);
        if (rubricPoints !== manualPoints) {
            context.addIssue({
                code: "custom",
                path: ["rubric"],
                message: "rubric points must equal the points not decided by the judge",
            });
        }
        if (new Set(problem.rubric.map((item) => item.id)).size !== problem.rubric.length) {
            context.addIssue({ code: "custom", path: ["rubric"], message: "duplicate rubric id" });
        }
    });

// What an instructor sends to create an exam. The window is when people may start; duration is how long
// each person has once they do; a session's deadline is the earlier of start plus duration plus their
// extra time and the window's end plus their extra time (ADR 0032).
export const examCreateRequestSchema = z
    .object({
        title: z.string().trim().min(1).max(EXAM_TITLE_CHARS_MAX),
        mode: examModeSchema,
        assurance_level: examAssuranceLevelSchema.default(1),
        duration_s: z.number().int().min(EXAM_DURATION_S_MIN).max(EXAM_DURATION_S_MAX),
        window_start: z.iso.datetime({ offset: true }),
        window_end: z.iso.datetime({ offset: true }),
        telemetry_retention_days: z
            .number()
            .int()
            .min(1)
            .max(TELEMETRY_RETENTION_DAYS_MAX)
            .default(TELEMETRY_RETENTION_DAYS_DEFAULT),
        problems: z.array(examProblemInputSchema).min(1).max(EXAM_PROBLEMS_MAX),
    })
    .strict()
    .superRefine((exam, context) => {
        const start = Date.parse(exam.window_start);
        const end = Date.parse(exam.window_end);
        const window = (end - start) / 1000;
        if (!(window >= exam.duration_s && window <= EXAM_WINDOW_S_MAX)) {
            context.addIssue({
                code: "custom",
                path: ["window_end"],
                message: "the window must hold the duration and be at most a week",
            });
        }
        const labels = exam.problems.map((problem) => problem.label);
        if (new Set(labels).size !== labels.length) {
            context.addIssue({ code: "custom", path: ["problems"], message: "duplicate label" });
        }
    });
export type ExamCreateRequest = z.infer<typeof examCreateRequestSchema>;

// One roster row from the CSV: who, and any accommodation in whole minutes of extra time.
export const rosterRowSchema = z
    .object({
        email: z.string().trim().toLowerCase().max(254).email(),
        name: z.string().trim().min(1).max(120),
        extra_minutes: z.number().int().min(0).max(EXAM_EXTRA_MINUTES_MAX).default(0),
    })
    .strict();

// The consent a candidate gives is to a text with a version; changing the text changes the version, so
// consent already given is never taken to cover new words.
export const CONSENT_TEXT_VERSION = 1;
export const examIdSchema = idSchema("exm");
export const sessionIdSchema = idSchema("exs");

// What a candidate is shown and agrees to before the first byte of telemetry. A new wording is a new version;
// consent to an older version never covers it. In Stage 6 consent is a condition of sitting the exam (a person
// who declines arranges something else with the instructor, outside the product); the text says so.
export const CONSENT_TEXTS: Readonly<Record<number, string>> = {
    1: [
        "Before you start, please read what this exam records about you.",
        "Your answers are saved while you work and graded by your instructor.",
        "While the exam is open the page also records, with the time of each event: when this window loses or regains focus, when you leave full screen, when you copy, cut or paste, when you edit your code, when you run it, and when your connection drops or returns. It records nothing else: no screen, camera, microphone, other programs or keystrokes outside your code.",
        "Your instructor and the people they appoint may look at these records to review a possible integrity problem. A computer program never decides that you cheated: a person decides, tells you why, and you can appeal.",
        "The records are kept for the period your institution chose and then deleted. You can ask your institution to see or delete them.",
        "If you do not agree, do not start; talk to your instructor about another arrangement.",
    ].join("\n\n"),
};

// One telemetry event as the page sends it (Stage 6, slice 6). `kind` is the closed list; `data` is small, typed
// per kind, and carries counts and durations only: never what was pasted or typed, never a screen or a device
// identifier. `t` is when the page saw it (unix ms); the server clamps it into the sitting.
const count = z.number().int().min(0).max(10_000_000);
export const telemetryEventSchema = z.discriminatedUnion("kind", [
    z
        .object({ kind: z.literal("focus_lost"), t: z.number().int(), data: z.object({}).strict() })
        .strict(),
    z
        .object({
            kind: z.literal("focus_gained"),
            t: z.number().int(),
            data: z.object({ away_ms: count }).strict(),
        })
        .strict(),
    z
        .object({
            kind: z.literal("fullscreen_exit"),
            t: z.number().int(),
            data: z.object({}).strict(),
        })
        .strict(),
    z
        .object({
            kind: z.literal("paste"),
            t: z.number().int(),
            data: z.object({ chars: count }).strict(),
        })
        .strict(),
    z
        .object({
            kind: z.literal("copy"),
            t: z.number().int(),
            data: z.object({ chars: count }).strict(),
        })
        .strict(),
    z
        .object({
            kind: z.literal("cut"),
            t: z.number().int(),
            data: z.object({ chars: count }).strict(),
        })
        .strict(),
    z
        .object({
            kind: z.literal("edit"),
            t: z.number().int(),
            data: z.object({ added: count, removed: count }).strict(),
        })
        .strict(),
    z
        .object({
            kind: z.literal("run"),
            t: z.number().int(),
            data: z.object({ language: z.string().max(32) }).strict(),
        })
        .strict(),
    z
        .object({ kind: z.literal("offline"), t: z.number().int(), data: z.object({}).strict() })
        .strict(),
    z
        .object({
            kind: z.literal("online"),
            t: z.number().int(),
            data: z.object({ offline_ms: count }).strict(),
        })
        .strict(),
]);
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

export const telemetryBatchSchema = z
    .object({ events: z.array(telemetryEventSchema).min(1).max(TELEMETRY_BATCH_EVENTS_MAX) })
    .strict();
