// Goal: the ICPC Contest API export matches the specification's own example (CCS spec 2023-06, scoreboard
// endpoint) and its rules: rank duplicated on ties, minutes as integers, RELTIME and TIME formats, the
// freeze shown as pending runs. The example below is the specification's; the numbers are not ours.

import type { ScoreboardBody } from "@aura/contracts/api/scoreboard";
import { describe, expect, it } from "vitest";
import { icpcScoreboardSchema, relativeTime, toIcpcScoreboard } from "./scoreboard-export.ts";

const cell = (label: string, over: Partial<ScoreboardBody["rows"][0]["cells"][0]> = {}) => ({
    label,
    solved: false,
    attempts: 0,
    minutes: null,
    points: 0,
    hidden: 0,
    ...over,
});
const row = (
    rank: number,
    participant: number,
    solved: number,
    penalty: number,
    last: number | null,
) => ({
    rank,
    participant,
    handle: null,
    display_name: null,
    solved,
    penalty_minutes: penalty,
    points: 0,
    last_change_s: last,
    cells: [cell("1"), cell("2")],
});
const board = (rows: ScoreboardBody["rows"]): ScoreboardBody => ({
    view: "public",
    format: "icpc",
    frozen: true,
    problems: [
        { label: "1", points: 100 },
        { label: "2", points: 100 },
    ],
    rows,
});
const context = {
    startsAt: new Date("2014-06-25T10:00:00.000Z"),
    endsAt: new Date("2014-06-25T15:00:00.000Z"),
    freezeAt: new Date("2014-06-25T14:00:00.000Z"),
    unfrozenAt: null,
    finalizedAt: null,
    state: "frozen",
    generatedAt: new Date("2014-06-25T14:13:07.832Z"),
};

describe("the specification's example", () => {
    it("is reproduced field for field", () => {
        const example = row(1, 123, 3, 340, 205 * 60);
        example.cells = [
            cell("1", { attempts: 3, hidden: 1 }),
            cell("2", { solved: true, attempts: 0, minutes: 20 }),
        ];
        const out = toIcpcScoreboard(board([example]), context);
        expect(out.contest_time).toBe("4:13:07.832"); // the specification's own RELTIME example
        expect(out.rows).toEqual([
            {
                rank: 1,
                team_id: "123",
                score: { num_solved: 3, total_time: 340, time: 205 },
                problems: [
                    { problem_id: "1", num_judged: 3, num_pending: 1, solved: false },
                    { problem_id: "2", num_judged: 1, num_pending: 0, solved: true, time: 20 },
                ],
            },
        ]);
        expect(icpcScoreboardSchema.safeParse(out).success).toBe(true);
    });
});

describe("the rules around it", () => {
    it("duplicates the rank on ties of solved and total time, and skips the numbers after", () => {
        const out = toIcpcScoreboard(
            board([
                row(1, 1, 2, 100, 600),
                row(2, 2, 2, 100, 900),
                row(3, 3, 2, 120, 700),
                row(4, 4, 0, 0, null),
            ]),
            context,
        );
        expect(out.rows.map((r) => r.rank)).toEqual([1, 1, 3, 4]);
        expect(out.rows[3]?.score.time).toBeNull(); // null exactly when nothing is solved
    });

    it("formats relative time and shows a freeze only to the view it applies to", () => {
        expect(relativeTime(0)).toBe("0:00:00.000");
        expect(relativeTime(3_599_999)).toBe("0:59:59.999");
        expect(relativeTime(-1500)).toBe("-0:00:01.500");
        const frozen = toIcpcScoreboard(board([row(1, 1, 0, 0, null)]), context);
        expect(frozen.state).toMatchObject({
            started: "2014-06-25T10:00:00.000Z",
            ended: null,
            frozen: "2014-06-25T14:00:00.000Z",
            thawed: null,
        });
        const final = toIcpcScoreboard(
            { ...board([row(1, 1, 0, 0, null)]), view: "final" },
            { ...context, state: "finalized", finalizedAt: new Date("2014-06-25T16:00:00.000Z") },
        );
        expect(final.state.frozen).toBeNull();
        expect(final.state.finalized).toBe("2014-06-25T16:00:00.000Z");
        expect(final.state.ended).toBe("2014-06-25T15:00:00.000Z");
    });

    it("refuses an IOI board instead of inventing times for it", () => {
        expect(() => toIcpcScoreboard({ ...board([]), format: "ioi" }, context)).toThrow();
    });
});
