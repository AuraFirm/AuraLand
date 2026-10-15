// Goal: every (organization, kind) lands in exactly one bucket. Equal counts are not differences; a count we have and they lack,
// a count they have and we lack, and two different counts each are; zero counts are the same as nothing; nonsense input stops
// loudly. Mutating any comparison below makes one of these fail.
import { describe, expect, it } from "vitest";
import { reconcile, type UsageLine } from "./reconcile.ts";

const line = (org: string, kind: UsageLine["kind"], count: number): UsageLine => ({
    org,
    kind,
    count,
});

describe("reconcile", () => {
    it("finds nothing when both sides agree, whatever the order", () => {
        const ours = [line("a", "env_run", 3), line("b", "employer_report", 1)];
        const theirs = [line("b", "employer_report", 1), line("a", "env_run", 3)];
        expect(reconcile(ours, theirs)).toEqual([]);
    });

    it("reports a count we have and the provider lacks", () => {
        expect(reconcile([line("a", "env_run", 3)], [])).toEqual([
            { type: "missing_at_provider", org: "a", kind: "env_run", ours: 3 },
        ]);
    });

    it("reports a count the provider has and we lack", () => {
        expect(reconcile([], [line("a", "env_run", 2)])).toEqual([
            { type: "unknown_at_provider", org: "a", kind: "env_run", theirs: 2 },
        ]);
    });

    it("reports two different counts, in both directions", () => {
        expect(reconcile([line("a", "env_run", 3)], [line("a", "env_run", 2)])).toEqual([
            { type: "count_mismatch", org: "a", kind: "env_run", ours: 3, theirs: 2 },
        ]);
        expect(reconcile([line("a", "env_run", 2)], [line("a", "env_run", 3)])).toEqual([
            { type: "count_mismatch", org: "a", kind: "env_run", ours: 2, theirs: 3 },
        ]);
    });

    it("keeps kinds apart and treats a zero count as no line", () => {
        expect(
            reconcile(
                [line("a", "env_run", 1), line("a", "employer_report", 0)],
                [line("a", "employer_report", 1)],
            ),
        ).toEqual([
            { type: "unknown_at_provider", org: "a", kind: "employer_report", theirs: 1 },
            { type: "missing_at_provider", org: "a", kind: "env_run", ours: 1 },
        ]);
        expect(reconcile([line("a", "env_run", 0)], [])).toEqual([]);
    });

    it("stops loudly on a list that repeats a key or holds a bad count", () => {
        expect(() => reconcile([line("a", "env_run", 1), line("a", "env_run", 1)], [])).toThrow();
        expect(() => reconcile([line("a", "env_run", -1)], [])).toThrow();
        expect(() => reconcile([], [line("a", "env_run", 1.5)])).toThrow();
    });
});
