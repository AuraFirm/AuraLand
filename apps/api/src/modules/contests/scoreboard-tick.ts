import { assert } from "@aura/contracts/assert";
import type { Clock } from "../../platform/clock.ts";
import {
    renderScoreboards,
    type ScoreboardInput,
    scoreboardInputSchema,
} from "./scoreboard-body.ts";
import type { TickContext } from "./tick.ts";

// The scoreboard tick (Stage 5, ADR 0031 decision 10). Once a second the worker asks which contests have
// a board that may be stale, rebuilds each from the judged log and stores it if it changed. One batch per
// tick, bounded; idempotent, so any number of workers may tick.
//
// Deviation from the plan's "delta since the last sequence number", on purpose: judging finishes out of
// order and a rejudge rewrites old verdicts, so a delta can miss a change. Rebuilding from the log is
// always right and, with the stamp check skipping untouched contests, costs one fold of a few thousand
// rows per changed contest per second. The fold is order independent and tested to equal incremental
// application, so a delta can replace this if a contest ever outgrows it.

export const SCOREBOARD_CONTESTS_PER_TICK_MAX = 20;

// The three things the tick needs from storage, so a simulation can stand in for Postgres.
export interface ScoreboardPort {
    work(limit: number): Promise<string[]>;
    input(contestId: string): Promise<unknown>;
    store(contestId: string, stored: StoredBoards, now: Date): Promise<boolean>;
}

export interface StoredBoards {
    readonly stamp: string;
    readonly rendered: ReturnType<typeof renderScoreboards>;
}

// Returns how many contests got a new board (an unchanged board is not counted).
export async function refreshScoreboards(
    port: ScoreboardPort,
    clock: Clock,
    limit: number = SCOREBOARD_CONTESTS_PER_TICK_MAX,
): Promise<number> {
    assert(limit >= 1 && limit <= SCOREBOARD_CONTESTS_PER_TICK_MAX, "the batch is bounded");
    const due = await port.work(limit);
    assert(due.length <= limit, "the database honors the batch size");
    let changed = 0;
    for (const contestId of due) {
        const input: ScoreboardInput = scoreboardInputSchema.parse(await port.input(contestId));
        assert(input.contest_id === contestId, "the input is for the contest asked about");
        const stored = { stamp: input.stamp, rendered: renderScoreboards(input) };
        if (await port.store(contestId, stored, new Date(clock.nowUnixMs()))) changed++;
    }
    return changed;
}

export function createPostgresScoreboardPort(context: TickContext): ScoreboardPort {
    return {
        async work(limit) {
            return context.inTransaction(async (tx) => {
                const rows = await tx<
                    { contest_id: string }[]
                >`select contest_id from scoreboard_work(${limit})`;
                return rows.map((row) => row.contest_id);
            });
        },
        async input(contestId) {
            return context.inTransaction(async (tx) => {
                const rows = await tx<
                    { doc: unknown }[]
                >`select scoreboard_input(${contestId}) as doc`;
                return rows[0]?.doc;
            });
        },
        async store(contestId, stored, now) {
            const { rendered } = stored;
            return context.inTransaction(async (tx) => {
                const rows = await tx<{ changed: boolean }[]>`select store_contest_scoreboard(
                    ${contestId}, ${stored.stamp}, ${now}, ${rendered.publicEtag},
                    ${tx.json(rendered.publicBody)}, ${rendered.finalEtag}, ${tx.json(rendered.finalBody)}) as changed`;
                return rows[0]?.changed === true;
            });
        },
    };
}
