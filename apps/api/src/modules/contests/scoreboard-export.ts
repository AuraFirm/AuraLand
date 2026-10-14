import type { ScoreboardBody } from "@aura/contracts/api/scoreboard";
import { assert } from "@aura/contracts/assert";
import { z } from "zod";

// The ICPC Contest API scoreboard (CCS specification, 2023-06, "scoreboard" endpoint), built from a stored
// board. Pure. Field names and meanings follow the specification; where it is silent we say so:
//   * only ICPC (pass-fail) contests export: the specification wants a per-problem time for every positive
//     score, which an IOI cell does not record, and we will not invent one;
//   * `rank` is duplicated on ties; a tie is equal solved count and equal total time (the ICPC convention;
//     the last-solve `time` only orders the rows within a tie), unlike our own total rank;
//   * `team_id` is the participant number and `problem_id` the problem label, both as strings;
//   * the specification does not say the unit of `total_time` and the score `time`; its example matches the
//     per-problem unit, minutes, and so do we;
//   * `num_judged` counts the judged runs up to and including the first correct one, `num_pending` the runs
//     the freeze is hiding (the board is a fold of judged runs, so queued runs are not counted).

const TIME = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const RELTIME = z.string().regex(/^-?\d+:\d{2}:\d{2}\.\d{3}$/);

const problemSchema = z
    .object({
        problem_id: z.string(),
        num_judged: z.number().int().min(0),
        num_pending: z.number().int().min(0),
        solved: z.boolean(),
        time: z.number().int().min(0).optional(),
    })
    .strict();

export const icpcScoreboardSchema = z
    .object({
        time: TIME,
        contest_time: RELTIME,
        state: z
            .object({
                started: TIME.nullable(),
                ended: TIME.nullable(),
                frozen: TIME.nullable(),
                thawed: TIME.nullable(),
                finalized: TIME.nullable(),
                end_of_updates: TIME.nullable(),
            })
            .strict(),
        rows: z.array(
            z
                .object({
                    rank: z.number().int().min(1),
                    team_id: z.string(),
                    score: z
                        .object({
                            num_solved: z.number().int().min(0),
                            total_time: z.number().int().min(0),
                            time: z.number().int().min(0).nullable(),
                        })
                        .strict(),
                    problems: z.array(problemSchema),
                })
                .strict(),
        ),
    })
    .strict();
export type IcpcScoreboard = z.infer<typeof icpcScoreboardSchema>;

export interface ExportContext {
    readonly startsAt: Date;
    readonly endsAt: Date;
    readonly freezeAt: Date | null;
    readonly unfrozenAt: Date | null;
    readonly finalizedAt: Date | null;
    readonly state: string;
    // When the stored board was made: the "event after which the scoreboard was generated".
    readonly generatedAt: Date;
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

export function relativeTime(milliseconds: number): string {
    const sign = milliseconds < 0 ? "-" : "";
    const total = Math.abs(milliseconds);
    const ms = total % MS_PER_SECOND;
    const seconds = Math.floor(total / MS_PER_SECOND) % SECONDS_PER_MINUTE;
    const minutes = Math.floor(total / (MS_PER_SECOND * SECONDS_PER_MINUTE)) % MINUTES_PER_HOUR;
    const hours = Math.floor(total / (MS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR));
    const pad = (n: number, width: number) => String(n).padStart(width, "0");
    return `${sign}${hours}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(ms, 3)}`;
}

function stateOf(context: ExportContext, view: ScoreboardBody["view"]) {
    const iso = (date: Date | null) => date?.toISOString() ?? null;
    const over = ["ended", "finalized"].includes(context.state);
    const frozen = ["frozen", "ended", "finalized"].includes(context.state);
    return {
        started: iso(context.startsAt),
        ended: over ? iso(context.endsAt) : null,
        // The final board is not frozen to its readers; the public one is, until the freeze is lifted.
        frozen:
            frozen && context.freezeAt !== null && view === "public" ? iso(context.freezeAt) : null,
        thawed: iso(context.unfrozenAt),
        finalized: iso(context.finalizedAt),
        end_of_updates: iso(context.finalizedAt),
    };
}

export function toIcpcScoreboard(body: ScoreboardBody, context: ExportContext): IcpcScoreboard {
    assert(body.format === "icpc", "only ICPC contests export");
    // Ties share the rank of the first row of the tie (1, 1, 3, ...).
    let tieRank = 0;
    const rows = body.rows.map((row, index) => {
        const previous = body.rows[index - 1];
        const tied =
            previous !== undefined &&
            previous.solved === row.solved &&
            previous.penalty_minutes === row.penalty_minutes;
        if (!tied) tieRank = index + 1;
        return {
            rank: tieRank,
            team_id: String(row.participant),
            score: {
                num_solved: row.solved,
                total_time: row.penalty_minutes,
                time:
                    row.last_change_s === null
                        ? null
                        : Math.floor(row.last_change_s / SECONDS_PER_MINUTE),
            },
            problems: row.cells.map((cell) => ({
                problem_id: cell.label,
                num_judged: cell.attempts + (cell.solved ? 1 : 0),
                num_pending: cell.hidden,
                solved: cell.solved,
                ...(cell.solved && cell.minutes !== null ? { time: cell.minutes } : {}),
            })),
        };
    });
    return icpcScoreboardSchema.parse({
        time: context.generatedAt.toISOString(),
        contest_time: relativeTime(context.generatedAt.getTime() - context.startsAt.getTime()),
        state: stateOf(context, body.view),
        rows,
    });
}
