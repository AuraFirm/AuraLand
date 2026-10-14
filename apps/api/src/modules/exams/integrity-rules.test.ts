// Goal: the thresholds of the integrity rules sit exactly where they say, and the pure decision rules hold at
// every edge. Method: the instant below and at each threshold, and every pair of (from, to) states.

import { describe, expect, it } from "vitest";
import {
    appealReviewAllowed,
    type Decision,
    decisionAllowed,
    type FlagState,
    FOCUS_LOSSES_MIN,
    focusFlag,
    PASTE_CHARS_MIN,
    pasteFlag,
    SIMILARITY_SCORE_MIN,
    similarityFlags,
} from "./integrity-rules.ts";

describe("thresholds", () => {
    it("flag at the threshold and not below it", () => {
        expect(focusFlag("s", FOCUS_LOSSES_MIN - 1)).toBeNull();
        expect(focusFlag("s", FOCUS_LOSSES_MIN)?.evidence).toMatchObject({
            count: FOCUS_LOSSES_MIN,
        });
        expect(pasteFlag("s", PASTE_CHARS_MIN - 1)).toBeNull();
        expect(pasteFlag("s", PASTE_CHARS_MIN)?.kind).toBe("large_paste");
        const pair = { label: "A", shared: 9, sessionA: "a", sessionB: "b" };
        expect(similarityFlags({ ...pair, score: SIMILARITY_SCORE_MIN - 0.01 })).toBeNull();
        expect(similarityFlags({ ...pair, score: SIMILARITY_SCORE_MIN })).toHaveLength(2);
    });

    it("keep the other person out of the words a candidate reads", () => {
        const flags = similarityFlags({
            label: "A",
            score: 0.95,
            shared: 9,
            sessionA: "sess-a",
            sessionB: "sess-b",
        });
        for (const flag of flags ?? []) {
            expect(flag.explanation).not.toContain("sess-");
            expect(JSON.stringify(flag.evidence)).toContain("other_session_id");
        }
    });
});

describe("decisions and reviews", () => {
    const states: FlagState[] = ["unreviewed", "clear", "needs_review", "confirmed", "dismissed"];
    const decisions: Decision[] = ["clear", "needs_review", "confirmed", "dismissed"];
    it("allow a decision from unreviewed, a settling one from needs_review, and nothing else", () => {
        for (const from of states)
            for (const to of decisions) {
                const expected =
                    from === "unreviewed" || (from === "needs_review" && to !== "needs_review");
                expect(decisionAllowed(from, to), `${from} to ${to}`).toBe(expected);
            }
    });

    it("keep an appeal from its own decider and from a second review", () => {
        expect(appealReviewAllowed({ appealOpen: true, flagDecidedBy: "a", reviewer: "b" })).toBe(
            "ok",
        );
        expect(appealReviewAllowed({ appealOpen: true, flagDecidedBy: "a", reviewer: "a" })).toBe(
            "same_person",
        );
        expect(appealReviewAllowed({ appealOpen: false, flagDecidedBy: "a", reviewer: "b" })).toBe(
            "not_open",
        );
        expect(() =>
            appealReviewAllowed({ appealOpen: true, flagDecidedBy: null, reviewer: "" }),
        ).toThrow();
    });
});
