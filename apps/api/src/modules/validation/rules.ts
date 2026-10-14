import { assert } from "@aura/contracts/assert";
import {
    VALIDATION_ATTACKERS,
    type ValidationCheck,
    type ValidationResult,
} from "@aura/contracts/validation";

// Turns what a judge node observed into the checks of a validation report. Pure: no I/O. The node
// reports raw verdicts per solution and test; every conclusion is drawn here, so a node cannot say
// "this task is fine", only show what it saw, and a report that cannot be true is rejected (and the
// job tried on another node) instead of being recorded.

export type Evaluation =
    | { readonly ok: true; readonly checks: readonly ValidationCheck[] }
    | { readonly ok: false; readonly reason: string };

type Run = ValidationResult["runs"][number];

const REFERENCE = /^reference\./;
const check = (name: string, ok: boolean, detail = ""): ValidationCheck => ({ name, ok, detail });
// A verdict that says the solution ran and was wrong, as opposed to the sandbox failing (SE).
const FAILED_FOR_REAL = new Set(["WA", "TLE", "MLE", "OLE", "RTE"]);

// A run must cover exactly the spec's tests (in any order) when it compiled, and none when it did
// not. Anything else cannot come from an honest node.
function shapeProblem(testIds: readonly string[], run: Run): string | null {
    const wanted = new Set(testIds);
    if (!run.compile_ok)
        return run.tests.length === 0 ? null : "tests reported after a failed compile";
    const seen = new Set<string>();
    for (const test of run.tests) {
        if (!wanted.has(test.test_id)) return `unknown test ${test.test_id}`;
        if (seen.has(test.test_id)) return `duplicate test ${test.test_id}`;
        if (test.verdict === "SE" || test.verdict === "CE") return `node reported ${test.verdict}`;
        seen.add(test.test_id);
    }
    return seen.size === wanted.size ? null : `run of ${run.solution} did not cover every test`;
}

function runsProblem(testIds: readonly string[], runs: readonly Run[]): string | null {
    const keys = new Set<string>();
    for (const run of runs) {
        const key = `${run.solution}#${run.repeat}`;
        if (keys.has(key)) return `duplicate run ${key}`;
        keys.add(key);
        if (run.repeat === 2 && !REFERENCE.test(run.solution))
            return "only the reference is run twice";
        const problem = shapeProblem(testIds, run);
        if (problem !== null) return problem;
    }
    return null;
}

function referenceChecks(runs: readonly Run[]): ValidationCheck[] {
    const first = runs.find((run) => REFERENCE.test(run.solution) && run.repeat === 1);
    if (first === undefined) return [check("reference_present", false, "no reference solution")];
    const checks = [
        check("reference_present", true),
        check("reference_compiles", first.compile_ok),
    ];
    if (!first.compile_ok) return checks;
    const failing = first.tests.filter((test) => test.verdict !== "AC");
    checks.push(
        check(
            "reference_passes",
            failing.length === 0,
            failing.length === 0 ? "" : `${failing.length} test(s) not AC`,
        ),
    );
    const second = runs.find((run) => REFERENCE.test(run.solution) && run.repeat === 2);
    const verdictOf = (run: Run) => new Map(run.tests.map((test) => [test.test_id, test.verdict]));
    const before = verdictOf(first);
    const same = second?.tests.every((test) => before.get(test.test_id) === test.verdict) === true;
    checks.push(
        check("reference_deterministic", same, second === undefined ? "second run missing" : ""),
    );
    return checks;
}

function wrongChecks(runs: readonly Run[]): ValidationCheck[] {
    const wrong = runs.filter((run) => !REFERENCE.test(run.solution));
    if (wrong.length === 0)
        return [check("wrong_solutions_present", false, "no wrong solution to learn from")];
    const checks = [check("wrong_solutions_present", true)];
    for (const run of wrong) {
        const name = `wrong_fails:${run.solution}`;
        if (!run.compile_ok) {
            checks.push(check(name, false, "does not compile, so it proves nothing"));
            continue;
        }
        const caught = run.tests.some((test) => FAILED_FOR_REAL.has(test.verdict));
        checks.push(check(name, caught, caught ? "" : "passed every test"));
    }
    return checks;
}

// Share of the mutants that compiled which the tests caught: 1 means every change to the reference
// failed some test. Null when no mutant compiled (nothing was learned). Used by the score (slice 5).
export function mutationKillRate(result: ValidationResult): number | null {
    const compiled = result.mutants.filter((mutant) => mutant.compile_ok);
    if (compiled.length === 0) return null;
    return compiled.filter((mutant) => mutant.killed).length / compiled.length;
}

function attackersProblem(testIds: readonly string[], result: ValidationResult): string | null {
    const names = result.attackers.map((attacker) => attacker.name).sort();
    const wanted = [...VALIDATION_ATTACKERS].sort();
    if (!result.bundle.opens)
        return names.length === 0 ? null : "attackers reported for a bundle that did not open";
    if (names.join() !== wanted.join())
        return "the built-in attackers were not all reported exactly once";
    const misreported = result.attackers.some(
        (attacker) => attacker.total !== testIds.length || attacker.passed > attacker.total,
    );
    return misreported ? "an attacker's counts do not fit the spec" : null;
}

function attackerChecks(result: ValidationResult): ValidationCheck[] {
    const order = new Map(VALIDATION_ATTACKERS.map((name, index) => [name, index]));
    return [...result.attackers]
        .sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0))
        .map((attacker) =>
            check(
                `attacker_rejected:${attacker.name}`,
                attacker.passed < attacker.total,
                attacker.passed < attacker.total ? "" : "passed every test",
            ),
        );
}

function mutantsProblem(result: ValidationResult): string | null {
    // A mutant that did not compile cannot have been killed by a test.
    return result.mutants.some((mutant) => mutant.killed && !mutant.compile_ok)
        ? "a mutant that did not compile was reported killed"
        : null;
}

export function evaluateValidation(
    testIds: readonly string[],
    result: ValidationResult,
): Evaluation {
    assert(testIds.length > 0, "a spec has at least one test");
    if (!result.bundle.opens) {
        if (result.runs.length + result.mutants.length + result.attackers.length > 0)
            return { ok: false, reason: "observations reported for a bundle that did not open" };
        return {
            ok: true,
            checks: [check("bundle_opens", false, result.bundle.refusal ?? "refused")],
        };
    }
    const problem =
        runsProblem(testIds, result.runs) ??
        mutantsProblem(result) ??
        attackersProblem(testIds, result);
    if (problem !== null) return { ok: false, reason: problem };
    const checks = [
        check("bundle_opens", true),
        ...referenceChecks(result.runs),
        ...wrongChecks(result.runs),
        ...attackerChecks(result),
    ];
    assert(
        checks.length >= 3,
        "a report always carries the bundle, reference and wrong-solution checks",
    );
    return { ok: true, checks };
}
