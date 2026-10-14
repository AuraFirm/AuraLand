import type { ValidationResult } from "@aura/contracts/validation";

// Pure rules of delivery watermarking (Stage 4C, ADR 0030): is a node's report good enough to deliver
// the rewritten bundle? The node ran the harness on the original and on the rewritten bundle; the
// bundle may ship only if every observable verdict is identical.

export type Judgement = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const verdictsOf = (result: ValidationResult) =>
    result.runs
        .map((run) => {
            const tests = run.tests
                .map((test) => `${test.test_id}=${test.verdict}`)
                .sort()
                .join(",");
            return `${run.solution}#${run.repeat}:${run.compile_ok}:${tests}`;
        })
        .sort();

const mutantsOf = (result: ValidationResult) =>
    result.mutants.map((m) => `${m.line}:${m.operator}:${m.compile_ok}:${m.killed}`).sort();

const attackersOf = (result: ValidationResult) =>
    result.attackers.map((a) => `${a.name}:${a.passed}/${a.total}`).sort();

function sameList(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

// Timing (cpu_ms) is ignored on purpose: it varies run to run and says nothing about correctness.
export function sameVerdicts(original: ValidationResult, rewritten: ValidationResult): Judgement {
    if (!original.bundle.opens || !rewritten.bundle.opens) {
        return { ok: false, reason: "a bundle that does not open cannot be delivered" };
    }
    if (original.runs.length === 0) {
        return {
            ok: false,
            reason: "the original has no solutions to compare, so nothing was checked",
        };
    }
    if (!sameList(verdictsOf(original), verdictsOf(rewritten))) {
        return {
            ok: false,
            reason: "a solution's verdicts differ between the original and the rewrite",
        };
    }
    if (!sameList(mutantsOf(original), mutantsOf(rewritten))) {
        return {
            ok: false,
            reason: "the mutants' outcomes differ between the original and the rewrite",
        };
    }
    if (!sameList(attackersOf(original), attackersOf(rewritten))) {
        return {
            ok: false,
            reason: "the attackers' outcomes differ between the original and the rewrite",
        };
    }
    return { ok: true };
}

// The harness cannot run a custom checker or an interactive task; for those the only change allowed is
// a comment line in a solution file, so no verdict re-check is required (and answers are never marked).
// Only the two fields that decide it, so a caller (and a test) need not build a whole spec.
interface Runnable {
    readonly checker: { readonly type: string };
    readonly interactive: boolean;
}

export const harnessCannotRun = (spec: Runnable): boolean =>
    spec.checker.type === "custom" || spec.interactive;

// Decides what to do with a node's report for a task.
export function judgeReport(
    spec: Runnable,
    result:
        | { readonly outcome: "unchanged" }
        | {
              readonly outcome: "rewritten";
              readonly answers: boolean;
              readonly solutions: boolean;
              readonly observations: {
                  original: ValidationResult;
                  rewritten: ValidationResult;
              } | null;
          },
): Judgement {
    if (result.outcome === "unchanged") return { ok: true };
    if (!result.answers && !result.solutions) {
        return { ok: false, reason: "a rewritten bundle must carry at least one mark" };
    }
    if (result.observations === null) {
        if (!harnessCannotRun(spec)) {
            return {
                ok: false,
                reason: "the harness can run this task, so the rewrite must be re-checked",
            };
        }
        if (result.answers)
            return { ok: false, reason: "answers are never marked without a re-check" };
        return { ok: true };
    }
    return sameVerdicts(result.observations.original, result.observations.rewritten);
}
