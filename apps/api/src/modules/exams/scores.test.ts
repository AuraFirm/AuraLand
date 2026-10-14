// Goal: points add up exactly and never exceed a problem. Method: worked splits, then every judge score and
// rubric choice on a grid, then hostile inputs that must be clamped.

import { describe, expect, it } from "vitest";
import { scoreAnswer, toPoints } from "./scores.ts";

const rubric = [
    { id: "style", label: "Style", max_points: 20 },
    { id: "tests", label: "Tests", max_points: 10 },
];
const base = { points: 100, autoPercent: 70, rubric };

describe("scoreAnswer", () => {
    it("splits a problem between the judge and the rubric", () => {
        const full = scoreAnswer({
            ...base,
            judgeScore: 100,
            rubricScores: { style: 20, tests: 10 },
        });
        expect([
            toPoints(full.autoMilli),
            toPoints(full.rubricMilli),
            toPoints(full.totalMilli),
        ]).toEqual([70, 30, 100]);
        const half = scoreAnswer({ ...base, judgeScore: 50, rubricScores: { style: 10 } });
        expect([
            toPoints(half.autoMilli),
            toPoints(half.rubricMilli),
            toPoints(half.totalMilli),
        ]).toEqual([35, 10, 45]);
    });

    it("gives nothing from the judge when nothing was judged", () => {
        const none = scoreAnswer({ ...base, judgeScore: null, rubricScores: { style: 5 } });
        expect([toPoints(none.autoMilli), toPoints(none.totalMilli)]).toEqual([0, 5]);
    });

    it("is exact in thousandths for awkward percentages and never exceeds the problem", () => {
        const odd = scoreAnswer({
            points: 7,
            autoPercent: 100,
            rubric: [],
            judgeScore: 33.333,
            rubricScores: {},
        });
        expect(odd.autoMilli).toBe(2333); // 7 * 33.333 / 100 = 2.33331 points, to the thousandth
        for (const judgeScore of [0, 1, 33.333, 50, 99.999, 100]) {
            for (const style of [0, 7, 20]) {
                const s = scoreAnswer({ ...base, judgeScore, rubricScores: { style } });
                expect(s.totalMilli).toBeLessThanOrEqual(100_000);
                expect(s.totalMilli).toBe(s.autoMilli + s.rubricMilli);
            }
        }
    });

    it("clamps hostile inputs instead of trusting them", () => {
        const s = scoreAnswer({
            ...base,
            judgeScore: 250,
            rubricScores: { style: 999, tests: -5, ghost: 50 },
        });
        expect([toPoints(s.autoMilli), toPoints(s.rubricMilli)]).toEqual([70, 20]); // 999 -> 20; -5 -> 0; ghost ignored
        expect(() =>
            scoreAnswer({ ...base, points: 0, judgeScore: 1, rubricScores: {} }),
        ).toThrow();
        expect(() =>
            scoreAnswer({ ...base, autoPercent: 101, judgeScore: 1, rubricScores: {} }),
        ).toThrow();
    });
});
