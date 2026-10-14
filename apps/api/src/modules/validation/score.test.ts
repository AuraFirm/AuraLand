// Goal: the ungameability score is the documented weighted sum, moves the right way for each part, and
// gates validation at the threshold. Method: build observations by hand and change one part at a time.
import {
    SCORE_THRESHOLD,
    SCORE_VERSION,
    VALIDATION_ATTACKERS,
    type ValidationResult,
} from "@aura/contracts/validation";
import { describe, expect, it } from "vitest";
import { evaluateValidation } from "./rules.ts";
import { ungameabilityScore } from "./score.ts";

const tests = [
    { id: "1", group: "a" },
    { id: "2", group: "a" },
    { id: "3", group: "b" },
    { id: "4", group: "b" },
];
const run = (solution: string, repeat: number, verdicts: ("AC" | "WA")[]) => ({
    solution,
    repeat,
    compile_ok: true,
    tests: verdicts.map((verdict, index) => ({ test_id: String(index + 1), verdict, cpu_ms: 1 })),
});
const mutant = (killed: boolean) => ({ operator: "+ to -", line: 1, compile_ok: true, killed });
function result(overrides: Partial<ValidationResult> = {}): ValidationResult {
    return {
        bundle: { opens: true },
        runs: [
            run("reference.cpp", 1, ["AC", "AC", "AC", "AC"]),
            run("reference.cpp", 2, ["AC", "AC", "AC", "AC"]),
            run("wrong_a.cpp", 1, ["AC", "WA", "AC", "AC"]),
        ],
        mutants: [mutant(true), mutant(true), mutant(true), mutant(true)],
        attackers: VALIDATION_ATTACKERS.map((name) => ({ name, passed: 0, total: 4 })),
        ...overrides,
    };
}
const scoreOf = (r: ValidationResult, spec = tests) => {
    const evaluation = evaluateValidation(spec, r);
    if (!evaluation.ok || evaluation.score === null) throw new Error("expected a score");
    return evaluation;
};

describe("ungameabilityScore", () => {
    it("is 100 for a task that stops everything", () => {
        const evaluation = scoreOf(result());
        expect(evaluation.score?.value).toBe(100);
        expect(evaluation.score?.version).toBe(SCORE_VERSION);
        expect(evaluation.checks.at(-1)).toEqual({
            name: `score_at_least_${SCORE_THRESHOLD}`,
            ok: true,
            detail: "score 100.00",
        });
    });

    it("loses 40 points for mutants nobody caught and counts only compiling ones", () => {
        expect(scoreOf(result({ mutants: [mutant(false), mutant(false)] })).score?.value).toBe(60);
        expect(scoreOf(result({ mutants: [mutant(true), mutant(false)] })).score?.value).toBe(80);
        const uncompiled = { operator: "<", line: 1, compile_ok: false, killed: false };
        expect(scoreOf(result({ mutants: [mutant(true), uncompiled] })).score?.value).toBe(100);
        expect(scoreOf(result({ mutants: [] })).score?.value).toBe(60); // nothing proven counts as nothing
    });

    it("loses 3 points per attacker that gets through", () => {
        const attackers = VALIDATION_ATTACKERS.map((name, index) => ({
            name,
            passed: index < 2 ? 4 : 0,
            total: 4,
        }));
        const evaluation = scoreOf(result({ attackers }));
        expect(evaluation.score?.value).toBe(94);
        expect(evaluation.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
            "attacker_rejected:sample_lookup",
            "attacker_rejected:echo_input",
        ]);
    });

    it("rewards groups with more than one test", () => {
        const single = [
            { id: "1", group: "a" },
            { id: "2", group: "b" },
            { id: "3", group: "b" },
            { id: "4", group: "b" },
        ];
        expect(scoreOf(result(), single).score?.parts.coverage).toBe(0.5);
        expect(scoreOf(result(), single).score?.value).toBe(95);
    });

    it("cannot validate a task under the threshold even when every consistency check passes", () => {
        const weak = scoreOf(
            result({
                mutants: [mutant(false)],
                attackers: VALIDATION_ATTACKERS.map((name, i) => ({
                    name,
                    passed: i < 4 ? 4 : 0,
                    total: 4,
                })),
            }),
        );
        expect(weak.score?.value).toBeLessThan(SCORE_THRESHOLD);
        expect(weak.checks.at(-1)?.ok).toBe(false);
    });

    it("keeps its parts within 0 to 1 and the sum within 0 to 100 for any observation", () => {
        const direct = ungameabilityScore({ result: result(), checks: [], tests });
        for (const part of Object.values(direct.parts)) expect(part >= 0 && part <= 1).toBe(true);
        expect(direct.value).toBeGreaterThanOrEqual(0);
        expect(direct.value).toBeLessThanOrEqual(100);
    });
});
