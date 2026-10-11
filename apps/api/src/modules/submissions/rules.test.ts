// Goal: the overall verdict and score come from the spec and the node's per-test results, never from
// the node's say-so; impossible reports are refused; binary, subtask and ratio scoring each behave as
// written.
import { taskSpecSchema } from "@aura/contracts/tasks";
import { describe, expect, it } from "vitest";
import { type NodeTestResult, summarize } from "./rules.ts";

const base = {
    spec_version: 1,
    kind: "algorithmic",
    title: "T",
    time_limit_ms: 1000,
    memory_limit_kib: 262144,
    output_limit_kib: 1024,
    languages: ["cpp"],
    checker: { type: "exact" },
    license: { owner: "o", terms: "t" },
    provenance: { author: "a", created: "2026-10-10", generated_with_ai: false },
};
const tests = [
    { id: "t1", group: "small", points: 10, is_sample: true },
    { id: "t2", group: "small", points: 10, is_sample: false },
    { id: "t3", group: "large", points: 80, is_sample: false },
];
const binary = taskSpecSchema.parse({ ...base, tests, scoring: { type: "binary", subtasks: [] } });
const subtasks = taskSpecSchema.parse({
    ...base,
    tests,
    scoring: {
        type: "subtasks",
        subtasks: [
            { group: "small", points: 20 },
            { group: "large", points: 80 },
        ],
    },
});
const ratio = taskSpecSchema.parse({ ...base, tests, scoring: { type: "ratio", subtasks: [] } });

const r = (testId: string, verdict: NodeTestResult["verdict"]): NodeTestResult => ({
    testId,
    verdict,
});
const all = (verdicts: Array<NodeTestResult["verdict"]>) =>
    verdicts.map((v, i) => r(`t${i + 1}`, v));

describe("binary scoring", () => {
    it("is accepted only when every test passes", () => {
        expect(summarize(binary, true, all(["AC", "AC", "AC"]))).toEqual({
            ok: true,
            verdict: "AC",
            score: 100,
        });
    });

    it("takes the first failing test's verdict and stops there", () => {
        expect(summarize(binary, true, all(["AC", "WA"]))).toEqual({
            ok: true,
            verdict: "WA",
            score: 0,
        });
        expect(summarize(binary, true, all(["TLE"]))).toEqual({
            ok: true,
            verdict: "TLE",
            score: 0,
        });
    });

    it("refuses reports that cannot be true", () => {
        const bad = (results: NodeTestResult[]) => summarize(binary, true, results).ok;
        expect(bad(all(["AC", "AC"]))).toBe(false); // stopped without a failure
        expect(bad(all(["WA", "AC"]))).toBe(false); // went on past a failure
        expect(bad([r("t2", "AC"), r("t1", "AC"), r("t3", "AC")])).toBe(false); // out of order
        expect(bad([r("t1", "AC"), r("t1", "AC"), r("t3", "AC")])).toBe(false); // duplicate
        expect(bad([r("zzz", "AC")])).toBe(false); // unknown test
        expect(bad([])).toBe(false);
    });
});

describe("subtask and ratio scoring", () => {
    it("gives a subtask its points only when all its tests pass", () => {
        expect(summarize(subtasks, true, all(["AC", "AC", "AC"]))).toEqual({
            ok: true,
            verdict: "AC",
            score: 100,
        });
        expect(summarize(subtasks, true, all(["AC", "AC", "WA"]))).toEqual({
            ok: true,
            verdict: "PARTIAL",
            score: 20,
        });
        expect(summarize(subtasks, true, all(["AC", "WA", "AC"]))).toEqual({
            ok: true,
            verdict: "PARTIAL",
            score: 80,
        });
        expect(summarize(subtasks, true, all(["WA", "WA", "RTE"]))).toEqual({
            ok: true,
            verdict: "WA",
            score: 0,
        });
    });

    it("needs every test reported", () => {
        expect(summarize(subtasks, true, all(["AC", "AC"])).ok).toBe(false);
        expect(summarize(ratio, true, all(["AC"])).ok).toBe(false);
    });

    it("gives a ratio task the points of the tests that passed", () => {
        expect(summarize(ratio, true, all(["AC", "WA", "AC"]))).toEqual({
            ok: true,
            verdict: "PARTIAL",
            score: 90,
        });
        expect(summarize(ratio, true, all(["AC", "AC", "AC"]))).toEqual({
            ok: true,
            verdict: "AC",
            score: 100,
        });
    });
});

describe("compile errors and system errors", () => {
    it("a compile failure is CE whatever else is reported", () => {
        expect(summarize(binary, false, [])).toEqual({ ok: true, verdict: "CE", score: 0 });
        expect(summarize(binary, false, all(["AC", "AC", "AC"]))).toEqual({
            ok: true,
            verdict: "CE",
            score: 0,
        });
    });

    it("a system error anywhere makes the whole verdict SE, never the participant's fault", () => {
        expect(summarize(binary, true, all(["AC", "SE"]))).toEqual({
            ok: true,
            verdict: "SE",
            score: 0,
        });
        expect(summarize(subtasks, true, all(["AC", "SE", "AC"]))).toEqual({
            ok: true,
            verdict: "SE",
            score: 0,
        });
    });
});
