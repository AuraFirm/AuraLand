import { toPoints } from "./scores.ts";

// The grade export (Stage 6, slice 5b): one row per candidate with each problem's points and the total. CSV that opens
// safely in a spreadsheet: a cell that starts with a character a spreadsheet treats as a formula (= + - @, a tab or a
// carriage return) is prefixed with an apostrophe, because names and emails come from a file an instructor uploaded.

export interface GradeRow {
    readonly email: string;
    readonly name: string;
    readonly sessionState: string;
    readonly problems: readonly { readonly label: string; readonly totalMilli: number }[];
}

export function csvCell(value: string): string {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function gradesCsv(labels: readonly string[], rows: readonly GradeRow[]): string {
    const header = ["email", "name", "status", ...labels, "total"];
    const lines = [header.map(csvCell).join(",")];
    for (const row of rows) {
        const byLabel = new Map(row.problems.map((p) => [p.label, p.totalMilli]));
        const cells = labels.map((label) => toPoints(byLabel.get(label) ?? 0));
        const total = cells.reduce((sum, points) => sum + points, 0);
        lines.push(
            [
                row.email,
                row.name,
                row.sessionState,
                ...cells.map(String),
                String(Math.round(total * 1000) / 1000),
            ]
                .map(csvCell)
                .join(","),
        );
    }
    return `${lines.join("\r\n")}\r\n`;
}
