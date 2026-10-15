import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import { eligibleStandings } from "./rating-tick.ts";
import { finalStandings, type ScoreboardInput, scoreboardInputSchema } from "./scoreboard-body.ts";

// The final standings of a contest as the rating sees them (people who submitted, ties shared), with how many
// problems each solved. Passport uses it to say what rank a person finished in; the contest module owns the rule.
export interface FinalRank {
    readonly userId: string;
    readonly rank: number;
    readonly solved: number;
}

export function finalRanksOf(input: ScoreboardInput): FinalRank[] {
    const solved = new Map(finalStandings(input).map((row) => [row.userId, row.solved]));
    return eligibleStandings(input).map((row) => ({
        userId: row.userId,
        rank: row.rank,
        solved: solved.get(row.userId) ?? 0,
    }));
}

export async function finalRanks(tx: Transaction, contestId: string): Promise<FinalRank[]> {
    const rows = await tx`select scoreboard_input(${contestId}) as doc`;
    const input = scoreboardInputSchema.parse(z.object({ doc: z.unknown() }).parse(rows[0]).doc);
    return finalRanksOf(input);
}
