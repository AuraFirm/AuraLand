// Goal: a rewritten bundle ships only when every observable verdict is identical to the original's.
// Method: build observations by hand and change one thing at a time.
import { VALIDATION_ATTACKERS, type ValidationResult } from "@aura/contracts/validation";
import { describe, expect, it } from "vitest";
import { harnessCannotRun, judgeReport, sameVerdicts } from "./rules.ts";

const observed = (): ValidationResult => ({
    bundle: { opens: true },
    runs: [
        {
            solution: "reference.cpp",
            repeat: 1,
            compile_ok: true,
            tests: [
                { test_id: "1", verdict: "AC", cpu_ms: 5 },
                { test_id: "2", verdict: "AC", cpu_ms: 7 },
            ],
        },
        {
            solution: "wrong_a.py",
            repeat: 1,
            compile_ok: true,
            tests: [
                { test_id: "1", verdict: "WA", cpu_ms: 9 },
                { test_id: "2", verdict: "AC", cpu_ms: 3 },
            ],
        },
    ],
    mutants: [{ operator: "+ to -", line: 3, compile_ok: true, killed: true }],
    attackers: VALIDATION_ATTACKERS.map((name) => ({ name, passed: 0, total: 2 })),
});
const spec = (checker: string, interactive = false) => ({
    checker: { type: checker },
    interactive,
});

describe("sameVerdicts", () => {
    it("accepts identical verdicts whatever the timing and the order", () => {
        const rewritten = observed();
        for (const run of rewritten.runs) for (const test of run.tests) test.cpu_ms += 100;
        rewritten.runs.reverse();
        rewritten.runs[0]?.tests.reverse();
        expect(sameVerdicts(observed(), rewritten)).toEqual({ ok: true });
    });

    it("refuses any change in a verdict, a mutant, an attacker or a compile", () => {
        const changes: Array<(r: ValidationResult) => void> = [
            (r) => {
                const test = r.runs[1]?.tests[0];
                if (test) test.verdict = "AC";
            },
            (r) => {
                const run = r.runs[0];
                if (run) run.compile_ok = false;
            },
            (r) => {
                const mutant = r.mutants[0];
                if (mutant) mutant.killed = false;
            },
            (r) => {
                const attacker = r.attackers[0];
                if (attacker) attacker.passed = 2;
            },
            (r) => r.runs.pop(),
            (r) => r.mutants.pop(),
        ];
        for (const change of changes) {
            const rewritten = observed();
            change(rewritten);
            expect(sameVerdicts(observed(), rewritten).ok).toBe(false);
        }
    });

    it("refuses a bundle that does not open and an original with nothing to compare", () => {
        const refused: ValidationResult = {
            bundle: { opens: false },
            runs: [],
            mutants: [],
            attackers: [],
        };
        expect(sameVerdicts(refused, refused).ok).toBe(false);
        const empty: ValidationResult = {
            bundle: { opens: true },
            runs: [],
            mutants: [],
            attackers: [],
        };
        expect(sameVerdicts(empty, empty).ok).toBe(false);
    });
});

describe("judgeReport", () => {
    const rewritten = (over: Record<string, unknown> = {}) => ({
        outcome: "rewritten" as const,
        answers: true,
        solutions: true,
        observations: { original: observed(), rewritten: observed() },
        ...over,
    });

    it("lets an unchanged bundle through and checks a rewritten one", () => {
        expect(judgeReport(spec("tokens"), { outcome: "unchanged" })).toEqual({ ok: true });
        expect(judgeReport(spec("tokens"), rewritten())).toEqual({ ok: true });
    });

    it("refuses a rewrite with no mark, or one that was not re-checked on a task the harness can run", () => {
        expect(
            judgeReport(spec("tokens"), rewritten({ answers: false, solutions: false })).ok,
        ).toBe(false);
        expect(judgeReport(spec("tokens"), rewritten({ observations: null })).ok).toBe(false);
    });

    it("allows a solutions-only rewrite without a re-check only where the harness cannot run", () => {
        expect(harnessCannotRun(spec("custom"))).toBe(true);
        expect(harnessCannotRun(spec("tokens", true))).toBe(true);
        expect(harnessCannotRun(spec("tokens"))).toBe(false);
        expect(
            judgeReport(spec("custom"), rewritten({ answers: false, observations: null })),
        ).toEqual({ ok: true });
        expect(
            judgeReport(spec("custom"), rewritten({ answers: true, observations: null })).ok,
        ).toBe(false);
    });
});
