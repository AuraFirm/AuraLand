// Goal: the save rule at its edges: the deadline instant, the sequence rule, repeats, and the caps.

import { describe, expect, it } from "vitest";
import { decideSave, type ServerView } from "./save-rules.ts";

const base: ServerView = {
    lastSeq: 3,
    lastHash: "h3",
    deadlineMs: 1000,
    sessionStarted: true,
    savesLastMinute: 0,
    savesForProblem: 3,
};

describe("decideSave", () => {
    it("stores a newer seq, also across a gap", () => {
        expect(decideSave(base, { seq: 4, hash: "h4", nowMs: 10 })).toEqual({
            kind: "stored",
            ackedSeq: 4,
        });
        expect(decideSave(base, { seq: 9, hash: "h9", nowMs: 10 })).toEqual({
            kind: "stored",
            ackedSeq: 9,
        });
    });

    it("acknowledges a repeat of the last save and conflicts on any other old or equal seq", () => {
        expect(decideSave(base, { seq: 3, hash: "h3", nowMs: 10 })).toEqual({
            kind: "repeat",
            ackedSeq: 3,
        });
        expect(decideSave(base, { seq: 3, hash: "other", nowMs: 10 })).toEqual({
            kind: "conflict",
            lastSeq: 3,
        });
        expect(decideSave(base, { seq: 2, hash: "h2", nowMs: 10 })).toEqual({
            kind: "conflict",
            lastSeq: 3,
        });
    });

    it("refuses at the deadline instant and after, but not one millisecond before", () => {
        expect(decideSave(base, { seq: 4, hash: "x", nowMs: 999 }).kind).toBe("stored");
        expect(decideSave(base, { seq: 4, hash: "x", nowMs: 1000 }).kind).toBe("over");
        expect(decideSave(base, { seq: 4, hash: "x", nowMs: 5000 }).kind).toBe("over");
        expect(
            decideSave({ ...base, sessionStarted: false }, { seq: 4, hash: "x", nowMs: 1 }).kind,
        ).toBe("over");
        // Over wins even for a repeat: nothing is acknowledged after the deadline.
        expect(decideSave(base, { seq: 3, hash: "h3", nowMs: 1000 }).kind).toBe("over");
    });

    it("limits the saves a minute and for a problem at the cap and not before", () => {
        expect(
            decideSave({ ...base, savesLastMinute: 59 }, { seq: 4, hash: "x", nowMs: 1 }).kind,
        ).toBe("stored");
        expect(
            decideSave({ ...base, savesLastMinute: 60 }, { seq: 4, hash: "x", nowMs: 1 }).kind,
        ).toBe("too_many");
        expect(
            decideSave({ ...base, savesForProblem: 20_000 }, { seq: 4, hash: "x", nowMs: 1 }).kind,
        ).toBe("too_many");
        expect(() => decideSave(base, { seq: 0, hash: "x", nowMs: 1 })).toThrow();
    });
});
