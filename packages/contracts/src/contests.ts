import { z } from "zod";
import {
    CONTEST_DURATION_S_MAX,
    CONTEST_DURATION_S_MIN,
    CONTEST_PENALTY_MINUTES_MAX,
    CONTEST_PROBLEMS_MAX,
    CONTEST_SUBMIT_INTERVAL_S_DEFAULT,
    CONTEST_SUBMIT_INTERVAL_S_MAX,
    CONTEST_TITLE_CHARS_MAX,
} from "./limits.ts";

// Contest vocabulary shared by the control plane, the screens and the simulations (Stage 5, ADR 0031).
// Only the ICPC and IOI formats exist; the kit's other formats are Stage 8 and later.

export const CONTEST_FORMATS = ["icpc", "ioi"] as const;
export const contestFormatSchema = z.enum(CONTEST_FORMATS);
export type ContestFormat = z.infer<typeof contestFormatSchema>;

// docs/kit/05 section 7: draft, scheduled, running, frozen, ended, finalized. Time moves a contest from
// scheduled to running to frozen to ended; people publish it (draft to scheduled) and finalize it.
export const CONTEST_STATES = [
    "draft",
    "scheduled",
    "running",
    "frozen",
    "ended",
    "finalized",
] as const;
export const contestStateSchema = z.enum(CONTEST_STATES);
export type ContestState = z.infer<typeof contestStateSchema>;

// Who can find a contest and its scoreboard: anyone (public), anyone with the link (unlisted), or only
// the people it was registered for and the host organization (private).
export const contestVisibilitySchema = z.enum(["public", "unlisted", "private"]);

// Whether the host claims anything about AI use. In Stage 5 it is only displayed: nothing enforces it
// because there is no telemetry yet (ADR 0031 decision 5).
export const contestAiPolicySchema = z.enum(["none", "allowed_logged", "agents_only"]);

// What the judge may run in this contest. A subset of the platform's languages.
export const contestLanguageSchema = z.enum(["cpp", "python3", "c", "java"]);

const sharedRules = {
    // The least time between two submissions of one person to one problem.
    submit_interval_s: z
        .number()
        .int()
        .min(0)
        .max(CONTEST_SUBMIT_INTERVAL_S_MAX)
        .default(CONTEST_SUBMIT_INTERVAL_S_DEFAULT),
    languages: z.array(contestLanguageSchema).min(1).max(4).default(["cpp", "python3"]),
};

// ICPC: solved count, then penalty (minutes to the first accepted run plus a fixed penalty for each
// rejected run before it). Compile errors never count as rejected runs.
const icpcRulesSchema = z
    .object({
        format: z.literal("icpc"),
        penalty_minutes_per_wrong: z
            .number()
            .int()
            .min(0)
            .max(CONTEST_PENALTY_MINUTES_MAX)
            .default(20),
        ...sharedRules,
    })
    .strict();

// IOI: the best score per problem over all runs, ties broken by the time of the last improvement.
const ioiRulesSchema = z.object({ format: z.literal("ioi"), ...sharedRules }).strict();

export const contestRulesSchema = z.discriminatedUnion("format", [icpcRulesSchema, ioiRulesSchema]);
export type ContestRules = z.infer<typeof contestRulesSchema>;

export const CONTEST_SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
// Problem labels as printed on a scoreboard: A, B, ... or A1, B2.
export const PROBLEM_LABEL = /^[A-Z][A-Z0-9]{0,2}$/;

export const contestProblemInputSchema = z
    .object({
        label: z.string().regex(PROBLEM_LABEL),
        task_version_id: z.string().min(1),
        // IOI problems may weigh differently; ICPC ignores it.
        points: z.number().int().min(1).max(1000).default(100),
    })
    .strict();

// What an organizer sends to create a contest. Times are instants (ISO 8601 with an offset); the server
// stores UTC. freeze_at is optional and must fall strictly between the start and the end.
export const contestCreateRequestSchema = z
    .object({
        slug: z.string().regex(CONTEST_SLUG),
        title: z.string().trim().min(1).max(CONTEST_TITLE_CHARS_MAX),
        rules: contestRulesSchema,
        visibility: contestVisibilitySchema.default("public"),
        ai_policy: contestAiPolicySchema.default("none"),
        rated: z.boolean().default(false),
        starts_at: z.iso.datetime({ offset: true }),
        ends_at: z.iso.datetime({ offset: true }),
        freeze_at: z.iso.datetime({ offset: true }).nullable().default(null),
        problems: z.array(contestProblemInputSchema).max(CONTEST_PROBLEMS_MAX).default([]),
    })
    .strict()
    .superRefine((contest, context) => {
        const start = Date.parse(contest.starts_at);
        const end = Date.parse(contest.ends_at);
        const duration = (end - start) / 1000;
        if (!(duration >= CONTEST_DURATION_S_MIN && duration <= CONTEST_DURATION_S_MAX)) {
            context.addIssue({
                code: "custom",
                path: ["ends_at"],
                message: "duration out of range",
            });
        }
        if (contest.freeze_at !== null) {
            const freeze = Date.parse(contest.freeze_at);
            if (!(freeze > start && freeze < end)) {
                context.addIssue({
                    code: "custom",
                    path: ["freeze_at"],
                    message: "freeze must fall inside the contest",
                });
            }
        }
        const labels = contest.problems.map((problem) => problem.label);
        if (new Set(labels).size !== labels.length) {
            context.addIssue({
                code: "custom",
                path: ["problems"],
                message: "duplicate problem label",
            });
        }
    });
export type ContestCreateRequest = z.infer<typeof contestCreateRequestSchema>;
