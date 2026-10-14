import { assert } from "@aura/contracts/assert";
import {
    SCORE_THRESHOLD,
    SCORE_VERSION,
    SCORE_WEIGHTS,
    type ValidationCheck,
    type ValidationResult,
} from "@aura/contracts/validation";

// The ungameability score (ADR 0029, formula version 1): how hard the task's tests are to pass without
// solving the problem, from 0 to 100. Pure; every input is something the control plane already checked.
//
//   40 x share of compiling mutants of the reference the tests caught
//   30 x share of the built-in attackers the tests rejected
//   20 x share of the consistency checks that passed
//   10 x share of test groups that hold at least two tests (a lone test cannot tell solvers apart)

export interface ScoreInput {
    readonly result: ValidationResult;
    // The checks before the score check itself: attackers are scored on their own, the rest are the
    // consistency checks.
    readonly checks: readonly ValidationCheck[];
    readonly tests: readonly { readonly id: string; readonly group: string }[];
}

export interface Score {
    readonly value: number;
    readonly version: number;
    readonly parts: {
        readonly mutation: number;
        readonly attackers: number;
        readonly consistency: number;
        readonly coverage: number;
    };
}

const share = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);

export function ungameabilityScore(input: ScoreInput): Score {
    assert(input.tests.length > 0, "a spec has at least one test");
    const compiled = input.result.mutants.filter((mutant) => mutant.compile_ok);
    const mutation = share(compiled.filter((mutant) => mutant.killed).length, compiled.length);
    const attackers = share(
        input.result.attackers.filter((attacker) => attacker.passed < attacker.total).length,
        input.result.attackers.length,
    );
    const consistencyChecks = input.checks.filter((c) => !c.name.startsWith("attacker_rejected:"));
    const consistency = share(
        consistencyChecks.filter((c) => c.ok).length,
        consistencyChecks.length,
    );
    const perGroup = new Map<string, number>();
    for (const test of input.tests) perGroup.set(test.group, (perGroup.get(test.group) ?? 0) + 1);
    const coverage = share(
        [...perGroup.values()].filter((count) => count >= 2).length,
        perGroup.size,
    );
    const value =
        SCORE_WEIGHTS.mutation * mutation +
        SCORE_WEIGHTS.attackers * attackers +
        SCORE_WEIGHTS.consistency * consistency +
        SCORE_WEIGHTS.coverage * coverage;
    assert(value >= 0 && value <= 100, "the weights sum to 100 and every share is in 0..1");
    return {
        value: Math.round(value * 100) / 100,
        version: SCORE_VERSION,
        parts: { mutation, attackers, consistency, coverage },
    };
}

export const scoreCheck = (score: Score): ValidationCheck => ({
    name: `score_at_least_${SCORE_THRESHOLD}`,
    ok: score.value >= SCORE_THRESHOLD,
    detail: `score ${score.value.toFixed(2)}`,
});
