// Goal: the clock moves a contest exactly as the kit's state machine says and a stopped worker cannot
// keep a finished contest taking submissions. Method: hand-picked instants around every boundary.
import { describe, expect, it } from "vitest";
import { acceptsSubmissions, type ContestClock, stateAt } from "./rules.ts";

const START = Date.parse("2026-11-01T10:00:00Z");
const FREEZE = Date.parse("2026-11-01T14:00:00Z");
const END = Date.parse("2026-11-01T15:00:00Z");
const contest = (state: ContestClock["state"], freeze: number | null = FREEZE): ContestClock => ({
    state,
    startsAtMs: START,
    endsAtMs: END,
    freezeAtMs: freeze,
});

describe("stateAt", () => {
    it("moves a scheduled contest through the states as time passes, boundaries inclusive at the start", () => {
        expect(stateAt(contest("scheduled"), START - 1)).toBe("scheduled");
        expect(stateAt(contest("scheduled"), START)).toBe("running");
        expect(stateAt(contest("scheduled"), FREEZE - 1)).toBe("running");
        expect(stateAt(contest("scheduled"), FREEZE)).toBe("frozen");
        expect(stateAt(contest("scheduled"), END - 1)).toBe("frozen");
        expect(stateAt(contest("scheduled"), END)).toBe("ended");
    });

    it("skips the frozen state when there is no freeze, and catches up after a long stop", () => {
        expect(stateAt(contest("scheduled", null), END - 1)).toBe("running");
        expect(stateAt(contest("scheduled", null), END + 86_400_000)).toBe("ended");
        expect(stateAt(contest("scheduled"), END + 86_400_000)).toBe("ended");
    });

    it("never moves draft, ended or finalized by the clock, and never goes backwards", () => {
        for (const state of ["draft", "ended", "finalized"] as const) {
            expect(stateAt(contest(state), END + 1)).toBe(state);
            expect(stateAt(contest(state), START - 1)).toBe(state);
        }
        expect(stateAt(contest("frozen"), START)).toBe("frozen");
        expect(stateAt(contest("running"), START - 1_000)).toBe("running");
    });

    it("refuses a contest whose times are impossible", () => {
        expect(() => stateAt({ ...contest("scheduled"), endsAtMs: START }, START)).toThrow();
        expect(() => stateAt(contest("scheduled", START), START)).toThrow();
        expect(() => stateAt(contest("scheduled", END), START)).toThrow();
    });
});

describe("acceptsSubmissions", () => {
    it("needs a live state and an instant inside the window", () => {
        expect(acceptsSubmissions(contest("running"), START)).toBe(true);
        expect(acceptsSubmissions(contest("running"), END - 1)).toBe(true);
        expect(acceptsSubmissions(contest("frozen"), FREEZE)).toBe(true);
        expect(acceptsSubmissions(contest("running"), END)).toBe(false);
        expect(acceptsSubmissions(contest("running"), START - 1)).toBe(false);
        for (const state of ["draft", "scheduled", "ended", "finalized"] as const) {
            expect(acceptsSubmissions(contest(state), START + 1)).toBe(false);
        }
    });

    it("refuses a submission after the end even when the worker never moved the state", () => {
        expect(acceptsSubmissions(contest("running"), END + 60_000)).toBe(false);
    });
});
