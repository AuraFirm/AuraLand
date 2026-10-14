// Goal: the draft attainment report keeps its shape. Method: a golden file for a fixed set of answers, plus the
// edges: the threshold instant, a problem nobody answered, and an empty exam.

import { describe, expect, it } from "vitest";
import {
    ATTAINMENT_THRESHOLD_PERCENT,
    type AttainmentRow,
    attainmentCsv,
} from "./attainment-report.ts";

const row = (
    label: string,
    session: string,
    totalMilli: number,
    answered = true,
): AttainmentRow => ({
    label,
    points: 100,
    sessionId: session,
    answered,
    totalMilli,
});

describe("attainmentCsv", () => {
    it("matches the golden report", () => {
        const csv = attainmentCsv([
            row("A", "s1", 100_000),
            row("A", "s2", 60_000),
            row("A", "s3", 59_999),
            row("A", "s4", 0, false),
            row("B", "s1", 30_000),
            row("B", "s2", 0, false),
        ]);
        expect(csv).toBe(
            [
                "problem,points,candidates,answered,mean_percent,attained,attained_percent",
                "A,100,4,3,55,2,50",
                "B,100,2,1,15,0,0",
                "",
            ].join("\r\n"),
        );
    });

    it("counts the threshold instant as attained and a hair below as not", () => {
        expect(ATTAINMENT_THRESHOLD_PERCENT).toBe(60);
        expect(attainmentCsv([row("A", "s", 60_000)])).toContain(",1,100\r\n");
        expect(attainmentCsv([row("A", "s", 59_999)])).toContain(",0,0\r\n");
    });

    it("has only a header for an exam with no answers", () => {
        expect(attainmentCsv([]).split("\r\n")).toEqual([
            "problem,points,candidates,answered,mean_percent,attained,attained_percent",
            "",
        ]);
    });
});
