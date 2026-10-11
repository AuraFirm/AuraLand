import { assert } from "@aura/contracts/assert";
import type { TestVerdict, Verdict } from "@aura/contracts/judging";
import type { TaskSpec } from "@aura/contracts/tasks";

// Turns what a judge node reports into the submission's verdict and score. Pure: no I/O. A node is a
// machine outside our trust, so its report is checked against the spec before it counts: the control
// plane, not the node, decides the overall verdict (docs/stages/stage-3-plan.md §7).

export interface NodeTestResult {
    readonly testId: string;
    readonly verdict: TestVerdict;
}

export type Summary =
    | { readonly ok: true; readonly verdict: Verdict; readonly score: number }
    // The report cannot be true (unknown test, duplicate, missing tests, results after a failure that
    // should have stopped the run). The job is treated as a system error and tried on another node.
    | { readonly ok: false; readonly reason: string };

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

// Binary tasks stop at the first failing test (the run is a prefix of the spec's order); every other
// scoring type needs all tests, because partial credit depends on the whole set.
function checkShape(spec: TaskSpec, results: readonly NodeTestResult[]): string | null {
    const order = spec.tests.map((test) => test.id);
    const seen = new Set<string>();
    for (const [index, result] of results.entries()) {
        if (!order.includes(result.testId)) return `unknown test ${result.testId}`;
        if (seen.has(result.testId)) return `duplicate test ${result.testId}`;
        seen.add(result.testId);
        if (spec.scoring.type === "binary" && order[index] !== result.testId)
            return "tests out of order";
    }
    if (spec.scoring.type !== "binary") {
        return results.length === order.length ? null : "not every test was reported";
    }
    const firstFailure = results.findIndex((result) => result.verdict !== "AC");
    if (firstFailure === -1)
        return results.length === order.length ? null : "the run stopped early without a failure";
    return firstFailure === results.length - 1 ? null : "results continue after the first failure";
}

function firstFailure(results: readonly NodeTestResult[]): Verdict {
    const failed = results.find((result) => result.verdict !== "AC");
    return failed === undefined ? "AC" : failed.verdict;
}

export function summarize(
    spec: TaskSpec,
    compileOk: boolean,
    results: readonly NodeTestResult[],
): Summary {
    assert(spec.tests.length >= 1, "a spec has tests");
    if (!compileOk) return { ok: true, verdict: "CE", score: 0 };
    const problem = checkShape(spec, results);
    if (problem !== null) return { ok: false, reason: problem };
    // A system error anywhere means the verdict says nothing about the code.
    if (results.some((result) => result.verdict === "SE"))
        return { ok: true, verdict: "SE", score: 0 };

    const passed = new Set(results.filter((r) => r.verdict === "AC").map((r) => r.testId));
    if (spec.scoring.type === "binary") {
        const total = sum(spec.tests.map((test) => test.points));
        const accepted = firstFailure(results) === "AC";
        return { ok: true, verdict: firstFailure(results), score: accepted ? total : 0 };
    }
    const groups = spec.scoring.type === "subtasks" ? spec.scoring.subtasks : null;
    const score =
        groups === null
            ? sum(spec.tests.filter((test) => passed.has(test.id)).map((test) => test.points))
            : sum(
                  groups
                      .filter((group) =>
                          spec.tests
                              .filter((t) => t.group === group.group)
                              .every((t) => passed.has(t.id)),
                      )
                      .map((group) => group.points),
              );
    const total =
        groups === null
            ? sum(spec.tests.map((test) => test.points))
            : sum(groups.map((group) => group.points));
    if (score === total) return { ok: true, verdict: "AC", score };
    if (score > 0) return { ok: true, verdict: "PARTIAL", score };
    return { ok: true, verdict: firstFailure(results), score: 0 };
}
