import { csvCell } from "./grades-csv.ts";

// The attainment report for an exam (Stage 6, slice 11): per problem, how many candidates there were, how many
// answered, the mean as a percentage of the problem's points, and how many reached the attainment threshold.
//
// This is a DRAFT template. Institutions report course outcomes (CO) and programme outcomes (PO); mapping each
// problem to outcomes, and the threshold their accreditor uses, need validation with a real customer before this
// is offered as their report. The threshold below is a placeholder, named so it is easy to find.
export const ATTAINMENT_THRESHOLD_PERCENT = 60;

export interface AttainmentRow {
    readonly label: string;
    readonly points: number;
    readonly sessionId: string;
    readonly answered: boolean;
    readonly totalMilli: number;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

export function attainmentCsv(rows: readonly AttainmentRow[]): string {
    const labels = [...new Set(rows.map((row) => row.label))].sort();
    const lines = [
        [
            "problem",
            "points",
            "candidates",
            "answered",
            "mean_percent",
            "attained",
            "attained_percent",
        ].join(","),
    ];
    for (const label of labels) {
        const mine = rows.filter((row) => row.label === label);
        const points = mine[0]?.points ?? 1;
        const candidates = new Set(mine.map((row) => row.sessionId)).size;
        const percents = mine.map((row) => (row.totalMilli / (points * 1000)) * 100);
        const mean =
            percents.length === 0 ? 0 : percents.reduce((sum, p) => sum + p, 0) / percents.length;
        const attained = percents.filter((p) => p >= ATTAINMENT_THRESHOLD_PERCENT).length;
        lines.push(
            [
                csvCell(label),
                points,
                candidates,
                mine.filter((row) => row.answered).length,
                round1(mean),
                attained,
                round1(candidates === 0 ? 0 : (attained / candidates) * 100),
            ].join(","),
        );
    }
    return `${lines.join("\r\n")}\r\n`;
}
