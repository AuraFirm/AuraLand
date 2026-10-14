// Goal: the control plane derives every check from raw observations and rejects reports that cannot be
// true. Method: build runs by hand, change one thing at a time.
import type { TestVerdict } from "@aura/contracts/judging";
import { VALIDATION_ATTACKERS, type ValidationResult } from "@aura/contracts/validation";
import { describe, expect, it } from "vitest";
import { evaluateValidation, mutationKillRate } from "./rules.ts";

const spec = [
    { id: "1", group: "all" },
    { id: "2", group: "all" },
];
type Verdicts = [TestVerdict, TestVerdict];
type Run = ValidationResult["runs"][number];
const run = (solution: string, verdicts: Verdicts, repeat = 1, compileOk = true): Run => ({
    solution,
    repeat,
    compile_ok: compileOk,
    tests: compileOk
        ? verdicts.map((verdict, index) => ({ test_id: String(index + 1), verdict, cpu_ms: 5 }))
        : [],
});
const rejected = () =>
    VALIDATION_ATTACKERS.map((name) => ({ name, passed: 0, total: spec.length }));
const good = (): ValidationResult => ({
    bundle: { opens: true },
    mutants: [{ operator: "+ to -", line: 1, compile_ok: true, killed: true }],
    attackers: rejected(),
    runs: [
        run("reference.cpp", ["AC", "AC"]),
        run("reference.cpp", ["AC", "AC"], 2),
        run("wrong_a.py", ["AC", "WA"]),
    ],
});

const failedNames = (result: ValidationResult) => {
    const evaluation = evaluateValidation(spec, result);
    if (!evaluation.ok) throw new Error(evaluation.reason);
    return evaluation.checks.filter((c) => !c.ok).map((c) => c.name);
};

describe("evaluateValidation", () => {
    it("passes a sound task with every check named", () => {
        const evaluation = evaluateValidation(spec, good());
        expect(evaluation.ok && evaluation.checks.map((c) => c.name)).toEqual([
            "bundle_opens",
            "reference_present",
            "reference_compiles",
            "reference_passes",
            "reference_deterministic",
            "wrong_solutions_present",
            "wrong_fails:wrong_a.py",
            ...VALIDATION_ATTACKERS.map((name) => `attacker_rejected:${name}`),
            "score_at_least_70",
        ]);
        expect(failedNames(good())).toEqual([]);
    });

    it("fails a task whose bundle did not open, naming the refusal", () => {
        const refused: ValidationResult = {
            bundle: { opens: false, refusal: "unexpected_file" },
            mutants: [],
            attackers: [],
            runs: [],
        };
        const evaluation = evaluateValidation(spec, refused);
        expect(evaluation).toEqual({
            ok: true,
            score: null,
            checks: [{ name: "bundle_opens", ok: false, detail: "unexpected_file" }],
        });
    });

    it("fails a reference that does not pass, does not compile, or differs between runs", () => {
        const wrongReference = good();
        wrongReference.runs[0] = run("reference.cpp", ["AC", "WA"]);
        wrongReference.runs[1] = run("reference.cpp", ["AC", "WA"], 2);
        expect(failedNames(wrongReference)).toEqual(["reference_passes"]);
        const flaky = good();
        flaky.runs[1] = run("reference.cpp", ["AC", "TLE"], 2);
        expect(failedNames(flaky)).toEqual(["reference_deterministic"]);
        const broken = good();
        broken.runs[0] = run("reference.cpp", ["AC", "AC"], 1, false);
        broken.runs[1] = run("reference.cpp", ["AC", "AC"], 2, false);
        expect(failedNames(broken)).toEqual(["reference_compiles"]);
    });

    it("fails a task with no reference, a second run missing, or no wrong solutions", () => {
        const noReference = good();
        noReference.runs = [run("wrong_a.py", ["AC", "WA"])];
        expect(failedNames(noReference)).toEqual(["reference_present"]);
        const once = good();
        once.runs.splice(1, 1);
        expect(failedNames(once)).toEqual(["reference_deterministic"]);
        const alone = good();
        alone.runs = alone.runs.slice(0, 2);
        expect(failedNames(alone)).toEqual(["wrong_solutions_present"]);
    });

    it("fails a wrong solution that passes everything or does not compile", () => {
        const weak = good();
        weak.runs[2] = run("wrong_a.py", ["AC", "AC"]);
        expect(failedNames(weak)).toEqual(["wrong_fails:wrong_a.py"]);
        const broken = good();
        broken.runs[2] = run("wrong_a.py", ["AC", "AC"], 1, false);
        expect(failedNames(broken)).toEqual(["wrong_fails:wrong_a.py"]);
    });
});

describe("evaluateValidation, wrong solutions and bad reports", () => {
    it("counts a time-out or crash as a caught wrong solution", () => {
        const stops: TestVerdict[] = ["TLE", "MLE", "RTE", "OLE"];
        for (const verdict of stops) {
            const caught = good();
            caught.runs[2] = run("wrong_a.py", ["AC", verdict]);
            expect(failedNames(caught)).toEqual([]);
        }
    });

    it("rejects reports that cannot be true instead of recording them", () => {
        const reject = (change: (r: ValidationResult) => void) => {
            const result = good();
            change(result);
            expect(evaluateValidation(spec, result).ok).toBe(false);
        };
        reject((r) => r.runs.push(run("wrong_a.py", ["AC", "WA"]))); // duplicate run
        reject((r) => r.runs.push(run("wrong_a.py", ["AC", "WA"], 2))); // wrong run twice
        reject((r) => {
            r.runs[2] = {
                ...run("wrong_a.py", ["AC", "WA"]),
                tests: [{ test_id: "1", verdict: "AC", cpu_ms: 1 }],
            };
        }); // missing test
        reject((r) => {
            r.runs[2] = run("wrong_a.py", ["AC", "SE"]);
        }); // sandbox failure
        reject((r) => {
            r.runs[2] = run("wrong_a.py", ["AC", "CE"]);
        });
        reject((r) => {
            r.runs[2] = {
                ...run("wrong_a.py", ["AC", "AC"]),
                tests: [
                    { test_id: "9", verdict: "AC", cpu_ms: 1 },
                    { test_id: "1", verdict: "AC", cpu_ms: 1 },
                ],
            };
        });
        reject((r) => {
            r.bundle = { opens: false };
        }); // runs after a refusal
        reject((r) => {
            r.runs[2] = {
                ...run("wrong_a.py", ["AC", "WA"], 1, false),
                tests: [{ test_id: "1", verdict: "AC", cpu_ms: 1 }],
            };
        });
    });
});

describe("mutants", () => {
    const mutant = (compileOk: boolean, killed: boolean) => ({
        operator: "+ to -",
        line: 1,
        compile_ok: compileOk,
        killed,
    });
    it("rates the tests by the share of compiling mutants they caught", () => {
        const result = good();
        result.mutants = [];
        expect(mutationKillRate(result)).toBeNull(); // nothing learned
        result.mutants = [
            mutant(true, true),
            mutant(true, true),
            mutant(true, false),
            mutant(false, false),
        ];
        expect(mutationKillRate(result)).toBeCloseTo(2 / 3);
        result.mutants = [mutant(true, true)];
        expect(mutationKillRate(result)).toBe(1);
    });

    it("rejects a report that kills a mutant that never compiled", () => {
        const result = good();
        result.mutants = [mutant(false, true)];
        expect(evaluateValidation(spec, result).ok).toBe(false);
    });
});

describe("attackers", () => {
    it("fails a task that a trivial program passes, naming the attacker", () => {
        const result = good();
        result.attackers = result.attackers.map((a) =>
            a.name === "constant_yes" ? { ...a, passed: a.total } : a,
        );
        expect(failedNames(result)).toEqual(["attacker_rejected:constant_yes"]);
    });

    it("rejects reports that skip an attacker, repeat one, or miscount", () => {
        const reject = (change: (r: ValidationResult) => void) => {
            const result = good();
            change(result);
            expect(evaluateValidation(spec, result).ok).toBe(false);
        };
        reject((r) => r.attackers.pop());
        reject((r) => {
            r.attackers[1] = { ...r.attackers[0], name: "sample_lookup", passed: 0, total: 2 };
        });
        reject((r) => {
            r.attackers[0] = { name: "sample_lookup", passed: 0, total: 5 };
        });
        reject((r) => {
            r.attackers[0] = { name: "sample_lookup", passed: 3, total: 2 };
        });
        reject((r) => {
            r.bundle = { opens: false };
            r.runs = [];
        });
    });
});
