import { z } from "zod";
import {
    contestAiPolicySchema,
    contestFormatSchema,
    contestProblemInputSchema,
    contestRulesSchema,
    contestStateSchema,
    contestVisibilitySchema,
    PROBLEM_LABEL,
} from "../contests.ts";
import { idSchema } from "../ids.ts";
import { CONTEST_TITLE_CHARS_MAX, CONTESTS_PAGE_SIZE_MAX } from "../limits.ts";

// Request and response shapes for contests (Stage 5). Responses are allowlists: a problem appears as a
// label and its weight; nothing of the task behind it (not its id, not its bundle) reaches a person who
// is not the host's staff.

export const contestProblemSchema = z
    .object({ label: z.string().regex(PROBLEM_LABEL), points: z.number().int().min(1).max(1000) })
    .strict();

export const contestSchema = z
    .object({
        id: idSchema("cst"),
        org_id: idSchema("org"),
        slug: z.string(),
        title: z.string(),
        format: contestFormatSchema,
        rules: contestRulesSchema,
        visibility: contestVisibilitySchema,
        ai_policy: contestAiPolicySchema,
        rated: z.boolean(),
        assurance_level: z.literal(0),
        state: contestStateSchema,
        starts_at: z.iso.datetime(),
        ends_at: z.iso.datetime(),
        freeze_at: z.iso.datetime().nullable(),
        finalized_at: z.iso.datetime().nullable(),
        // When the host ended the freeze (or finalized); null while the public board still stops at the freeze.
        unfrozen_at: z.iso.datetime().nullable(),
        // Visible once the contest has started, or to the host's staff before.
        problems: z.array(contestProblemSchema),
        // null for someone who is not signed in.
        registered: z.boolean().nullable(),
        // The host's owners and admins may arrange and publish it.
        can_manage: z.boolean(),
    })
    .strict();
export type ContestItem = z.infer<typeof contestSchema>;

export const contestsResponseSchema = z
    .object({ contests: z.array(contestSchema), next_cursor: idSchema("cst").nullable() })
    .strict();

export const contestListQuerySchema = z
    .object({
        // Absent: the public listing. Present: that organization's contests, drafts included for its staff.
        org_id: idSchema("org").optional(),
        limit: z.coerce.number().int().min(1).max(CONTESTS_PAGE_SIZE_MAX).default(20),
        cursor: idSchema("cst").optional(),
    })
    .strict();

// Only draft contests change; the same limits as creation apply (the database repeats them).
export const contestUpdateRequestSchema = z
    .object({
        title: z.string().trim().min(1).max(CONTEST_TITLE_CHARS_MAX).optional(),
        rules: contestRulesSchema.optional(),
        visibility: contestVisibilitySchema.optional(),
        ai_policy: contestAiPolicySchema.optional(),
        rated: z.boolean().optional(),
        starts_at: z.iso.datetime({ offset: true }).optional(),
        ends_at: z.iso.datetime({ offset: true }).optional(),
        freeze_at: z.iso.datetime({ offset: true }).nullable().optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, "nothing to change");

export const contestProblemAddRequestSchema = contestProblemInputSchema.extend({
    task_version_id: idSchema("tsv"),
});

export const registrationResponseSchema = z
    .object({ status: z.enum(["registered", "already"]) })
    .strict();
