import { z } from "zod";
import { orgNameSchema, orgSlugSchema } from "./identity.ts";
import {
    MEMORY_LIMIT_KIB_MAX,
    MEMORY_LIMIT_KIB_MIN,
    OUTPUT_LIMIT_KIB_MAX,
    SPEC_LANGUAGES_MAX,
    SPEC_SUBTASKS_MAX,
    SPEC_TESTS_MAX,
    STATEMENT_BYTES_MAX,
    TASK_SLUG_LENGTH_MAX,
    TASK_SLUG_LENGTH_MIN,
    TASK_TITLE_LENGTH_MAX,
    TIME_LIMIT_MS_MAX,
    TIME_LIMIT_MS_MIN,
} from "./limits.ts";

// Task domain types and the TaskSpec (docs/kit/07 section 7). The spec lists tests by id and
// group only: test contents are hidden material and live in the bundle, never in a schema.

// All five kinds exist in the data model; only the first two are accepted until their stages.
export const TASK_KINDS = ["algorithmic", "function", "repo_env", "sql", "agent_env"] as const;
export const TASK_KINDS_SUPPORTED = ["algorithmic", "function"] as const;
export const taskKindSchema = z.enum(TASK_KINDS);
export const supportedTaskKindSchema = z.enum(TASK_KINDS_SUPPORTED);

// "public" and "licensed" are stored but grant nothing until the marketplace stage.
export const TASK_VISIBILITIES = ["private", "org", "public", "licensed"] as const;
export const taskVisibilitySchema = z.enum(TASK_VISIBILITIES);

export const VERSION_STATES = [
    "draft",
    "uploaded",
    "in_review",
    "validating",
    "validated",
    "released",
    "retired",
    "rejected",
] as const;
export const versionStateSchema = z.enum(VERSION_STATES);

export const REVIEW_OUTCOMES = ["approved", "changes_requested", "rejected"] as const;
export const reviewOutcomeSchema = z.enum(REVIEW_OUTCOMES);

export const taskSlugSchema = orgSlugSchema.min(TASK_SLUG_LENGTH_MIN).max(TASK_SLUG_LENGTH_MAX);
export const taskTitleSchema = orgNameSchema.max(TASK_TITLE_LENGTH_MAX);

// UTF-8 bytes, not characters: the cap protects storage and rendering work, which count bytes.
export const statementSchema = z
    .string()
    .min(1)
    .refine(
        (text) => new TextEncoder().encode(text).length <= STATEMENT_BYTES_MAX,
        `statement is larger than ${STATEMENT_BYTES_MAX} bytes`,
    );

// A name that is safe as a file name inside a bundle and as an id in a report.
const entryNameSchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "letters, digits, dot, dash and underscore only");

const languageSchema = z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9_+.-]*$/, "lowercase language token");

const specTestSchema = z
    .object({
        id: entryNameSchema,
        group: entryNameSchema,
        points: z.number().min(0).max(1_000_000),
        is_sample: z.boolean(),
    })
    .strict();

const specSubtaskSchema = z
    .object({ group: entryNameSchema, points: z.number().min(0).max(1_000_000) })
    .strict();

const scoringSchema = z
    .object({
        type: z.enum(["binary", "subtasks", "ratio"]),
        subtasks: z.array(specSubtaskSchema).max(SPEC_SUBTASKS_MAX).default([]),
    })
    .strict();

const licenseSchema = z
    .object({ owner: orgNameSchema, terms: z.string().min(1).max(200) })
    .strict();

const provenanceSchema = z
    .object({
        author: orgNameSchema,
        reviewers: z.array(orgNameSchema).max(20).default([]),
        created: z.iso.date(),
        generated_with_ai: z.boolean(),
    })
    .strict();

export const TASK_SPEC_VERSION = 1;

// Checks that cross fields: unique ids, subtask groups that exist, and points that add up. Failing
// here is what keeps a spec from describing a task that cannot be scored.
function checkSpecConsistency(
    spec: {
        tests: { id: string; group: string }[];
        scoring: { type: string; subtasks: { group: string }[] };
    },
    context: z.RefinementCtx,
): void {
    const ids = new Set<string>();
    for (const test of spec.tests) {
        if (ids.has(test.id)) {
            context.addIssue({ code: "custom", message: `duplicate test id ${test.id}` });
        }
        ids.add(test.id);
    }
    const groups = new Set(spec.tests.map((test) => test.group));
    for (const subtask of spec.scoring.subtasks) {
        if (!groups.has(subtask.group)) {
            context.addIssue({ code: "custom", message: `subtask ${subtask.group} has no tests` });
        }
    }
    if (spec.scoring.type === "subtasks" && spec.scoring.subtasks.length === 0) {
        context.addIssue({ code: "custom", message: "subtask scoring needs subtasks" });
    }
}

export const taskSpecSchema = z
    .object({
        spec_version: z.literal(TASK_SPEC_VERSION),
        kind: supportedTaskKindSchema,
        title: taskTitleSchema,
        time_limit_ms: z.number().int().min(TIME_LIMIT_MS_MIN).max(TIME_LIMIT_MS_MAX),
        memory_limit_kib: z.number().int().min(MEMORY_LIMIT_KIB_MIN).max(MEMORY_LIMIT_KIB_MAX),
        output_limit_kib: z.number().int().min(1).max(OUTPUT_LIMIT_KIB_MAX),
        languages: z.array(languageSchema).min(1).max(SPEC_LANGUAGES_MAX),
        scoring: scoringSchema,
        tests: z.array(specTestSchema).min(1).max(SPEC_TESTS_MAX),
        checker: z.object({ type: z.enum(["exact", "tokens", "float", "custom"]) }).strict(),
        interactive: z.boolean().default(false),
        license: licenseSchema,
        provenance: provenanceSchema,
    })
    .strict()
    .superRefine(checkSpecConsistency);

export type TaskSpec = z.infer<typeof taskSpecSchema>;

export type VersionState = z.infer<typeof versionStateSchema>;
export type TaskKind = z.infer<typeof taskKindSchema>;
