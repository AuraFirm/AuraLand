import { assert } from "@aura/contracts/assert";

// How an answer's points add up (Stage 6, ADR 0032 decision 12). Pure. A problem's `points` are split: the share
// `auto_percent` follows the judge's score (a percentage, 0 to 100), the rest is the sum of the rubric items a
// person scored. Everything is kept in thousandths of a point so sums are exact and never exceed the problem.

const MILLI = 1000;

export interface RubricItem {
    readonly id: string;
    readonly label: string;
    readonly max_points: number;
}

export interface AnswerScore {
    readonly autoMilli: number;
    readonly rubricMilli: number;
    readonly totalMilli: number;
}

export function scoreAnswer(input: {
    readonly points: number;
    readonly autoPercent: number;
    readonly rubric: readonly RubricItem[];
    readonly judgeScore: number | null; // percentage; null when nothing was judged (no answer, or not judged yet)
    readonly rubricScores: Readonly<Record<string, number>>;
}): AnswerScore {
    assert(
        input.points >= 1 && input.autoPercent >= 0 && input.autoPercent <= 100,
        "a problem has points and a share",
    );
    const percent = Math.min(100, Math.max(0, input.judgeScore ?? 0));
    const autoMilli = Math.round((input.points * input.autoPercent * percent * MILLI) / 10_000);
    let rubricMilli = 0;
    for (const item of input.rubric) {
        // An unknown, negative or too-large score is a bug upstream (the database refuses it); here it is clamped.
        const given = Math.min(item.max_points, Math.max(0, input.rubricScores[item.id] ?? 0));
        rubricMilli += given * MILLI;
    }
    const totalMilli = Math.min(input.points * MILLI, autoMilli + rubricMilli);
    assert(
        totalMilli >= 0 && totalMilli <= input.points * MILLI,
        "a total never exceeds the problem's points",
    );
    return { autoMilli, rubricMilli, totalMilli };
}

export const toPoints = (milli: number): number => milli / MILLI;
