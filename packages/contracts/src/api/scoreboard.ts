import { z } from "zod";
import { CONTEST_PROBLEMS_MAX } from "../limits.ts";

// The rendered board of a contest (Stage 5, ADR 0031 decision 10). The worker builds it from the judged
// log and stores it; the read path (slice 6) serves it. It names no user id: a person is "participant N"
// (N = registration order + 1), and carries a handle and display name only if their profile is public.
// Hence it is safe to cache and to share between viewers.

const SCOREBOARD_ROWS_MAX = 100_000; // far above any contest we run; the bound is for the parser

export const scoreboardCellSchema = z
    .object({
        label: z.string(),
        solved: z.boolean(),
        attempts: z.number().int().min(0),
        minutes: z.number().int().min(0).nullable(),
        points: z.number().min(0),
        hidden: z.number().int().min(0),
    })
    .strict();

export const scoreboardRowSchema = z
    .object({
        rank: z.number().int().min(1),
        participant: z.number().int().min(1),
        handle: z.string().nullable(),
        display_name: z.string().nullable(),
        solved: z.number().int().min(0),
        penalty_minutes: z.number().int().min(0),
        points: z.number().min(0),
        last_change_s: z.number().int().min(0).nullable(),
        cells: z.array(scoreboardCellSchema).max(CONTEST_PROBLEMS_MAX),
    })
    .strict();

export const scoreboardBodySchema = z
    .object({
        view: z.enum(["public", "final"]),
        format: z.enum(["icpc", "ioi"]),
        // True when this board leaves out what happened after the freeze.
        frozen: z.boolean(),
        problems: z
            .array(z.object({ label: z.string(), points: z.number().int().min(1) }).strict())
            .max(CONTEST_PROBLEMS_MAX),
        rows: z.array(scoreboardRowSchema).max(SCOREBOARD_ROWS_MAX),
    })
    .strict();
export type ScoreboardBody = z.infer<typeof scoreboardBodySchema>;
