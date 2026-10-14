import { assert } from "@aura/contracts/assert";
import { CONTEST_RATED_PARTICIPANTS_MIN } from "@aura/contracts/limits";
import {
    RATING_DIMENSION_CONTEST,
    RATING_PARAMETERS_V1,
    RATING_PARTICIPANTS_MAX,
    type RatingParameters,
} from "@aura/contracts/rating";
import { z } from "zod";
import type { Clock } from "../../platform/clock.ts";
import { type RatingPrior, type RatingStanding, rateContest } from "./rating.ts";
import type { Standing } from "./scoreboard.ts";
import { finalStandings, type ScoreboardInput, scoreboardInputSchema } from "./scoreboard-body.ts";
import type { TickContext } from "./tick.ts";

// The rating job (Stage 5, ADR 0031 decision 7). The worker asks for the oldest finalized, rated contest
// that has not been rated and rates it in one transaction that holds the rating lock: the priors it reads
// cannot change before it writes, and a contest is rated at most once because the run is recorded in the
// same transaction. A tick rates at most one contest; the rest wait for the next tick.

export const RATING_TICK_MS = 5_000;

export type RatingOutcome = "none" | "rated" | "skipped";

export async function rateNextContest(
    context: TickContext,
    clock: Clock,
    parameters: RatingParameters = RATING_PARAMETERS_V1,
): Promise<RatingOutcome> {
    return context.inTransaction(async (tx) => {
        const next = await tx`select rating_begin(${RATING_DIMENSION_CONTEST}) as id`;
        const contestId = z.object({ id: z.string().nullable() }).parse(next[0]).id;
        if (contestId === null) return "none";
        const doc = await tx`select scoreboard_input(${contestId}) as doc`;
        const input = scoreboardInputSchema.parse(z.object({ doc: z.unknown() }).parse(doc[0]).doc);
        assert(input.contest_id === contestId, "the input is for the contest asked about");
        const standings = eligibleStandings(input);
        let events: ReturnType<typeof rate> = [];
        if (
            standings.length >= CONTEST_RATED_PARTICIPANTS_MIN &&
            standings.length <= RATING_PARTICIPANTS_MAX
        ) {
            const rows = await tx`select user_id, mu, sigma from rating_priors(
                ${tx.array(standings.map((s) => s.userId))}::uuid[], ${RATING_DIMENSION_CONTEST})`;
            events = rate(standings, rows, parameters);
        }
        await tx`select rating_apply(${contestId}, ${RATING_DIMENSION_CONTEST},
            ${events.length === 0 ? "skipped" : "rated"}, ${parameters.version}, ${tx.json(events)},
            ${new Date(clock.nowUnixMs())})`;
        return events.length === 0 ? "skipped" : "rated";
    });
}

// Only people who submitted are rated (registering to watch is not taking part), ranked among themselves
// with ties as the scoreboard defines them: equal solved count and penalty (ICPC) or equal points (IOI).
export function eligibleStandings(input: ScoreboardInput): RatingStanding[] {
    const submitted = new Set(input.events.map((e) => e.user_id));
    const rows = finalStandings(input).filter((row) => submitted.has(row.userId));
    const key = (row: Standing) =>
        input.format === "icpc" ? `${row.solved}:${row.penaltyMinutes}` : `${row.points}`;
    let tieRank = 0;
    return rows.map((row, index) => {
        const previous = rows[index - 1];
        if (previous === undefined || key(previous) !== key(row)) tieRank = index + 1;
        return { userId: row.userId, rank: tieRank };
    });
}

const priorRowSchema = z.object({ user_id: z.string(), mu: z.number(), sigma: z.number() });

function rate(
    standings: readonly RatingStanding[],
    priorRows: readonly unknown[],
    parameters: RatingParameters,
) {
    const known = new Map(
        priorRows.map((row) => priorRowSchema.parse(row)).map((r) => [r.user_id, r]),
    );
    const priors: RatingPrior[] = standings.map((s) => {
        const prior = known.get(s.userId);
        return {
            userId: s.userId,
            mu: prior?.mu ?? parameters.muInitial,
            sigma: prior?.sigma ?? parameters.sigmaInitial,
        };
    });
    return rateContest(priors, standings, parameters).map((r) => ({
        user_id: r.userId,
        rank: r.rank,
        mu_before: r.muBefore,
        mu_after: r.muAfter,
        sigma_after: r.sigmaAfter,
        performance: r.performance,
    }));
}
