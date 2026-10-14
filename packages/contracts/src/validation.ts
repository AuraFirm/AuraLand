import { z } from "zod";
import { idSchema } from "./ids.ts";
import { testVerdictSchema } from "./judging.ts";
import { BUNDLE_WRONG_SOLUTIONS_MAX, SPEC_TESTS_MAX, VALIDATION_MUTANTS_MAX } from "./limits.ts";
import { taskSpecSchema } from "./tasks.ts";

// Validation of a task version (Stage 4B, ADR 0029). A judge node runs the bundle's own solutions and
// reports raw observations; the control plane derives every check from them. A node's claim of
// "this task is good" does not exist in this protocol, only what it saw.

// The names the bundle validator accepts under solutions/ (packages/bundle/src/validate.ts).
export const SOLUTION_NAME = /^(reference|wrong_[A-Za-z0-9][A-Za-z0-9_-]*)\.(cpp|py)$/;

// Two runs of the reference decide determinism; every wrong solution runs once.
export const VALIDATION_RUNS_MAX = BUNDLE_WRONG_SOLUTIONS_MAX + 2;

export const validationJobSchema = z
    .object({
        job_id: idSchema("job"),
        lease_epoch: z.number().int().min(1),
        lease_ttl_s: z.number().int().min(1),
        kind: z.literal("task.validate"),
        task: z
            .object({
                version_id: idSchema("tsv"),
                bundle: z
                    .object({
                        sha256: z.string().regex(/^[0-9a-f]{64}$/),
                        bytes: z.number().int().min(1),
                    })
                    .strict(),
                spec: taskSpecSchema,
            })
            .strict(),
    })
    .strict();

export const validationTestSchema = z
    .object({
        test_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
        verdict: testVerdictSchema,
        cpu_ms: z.number().int().min(0).max(3_600_000),
    })
    .strict();

export const validationRunSchema = z
    .object({
        solution: z.string().regex(SOLUTION_NAME),
        repeat: z.number().int().min(1).max(2),
        compile_ok: z.boolean(),
        tests: z.array(validationTestSchema).max(SPEC_TESTS_MAX),
    })
    .strict();

// One change to the reference (what was swapped and where), and whether the tests noticed it. A mutant
// that does not compile proves nothing about the tests and is not counted either way.
export const validationMutantSchema = z
    .object({
        operator: z.string().min(1).max(40),
        line: z.number().int().min(1).max(1_000_000),
        compile_ok: z.boolean(),
        killed: z.boolean(),
    })
    .strict();

export const validationResultSchema = z
    .object({
        // The opener's answer: opens, or the validator's refusal code (never content).
        bundle: z.object({ opens: z.boolean(), refusal: z.string().max(64).optional() }).strict(),
        runs: z.array(validationRunSchema).max(VALIDATION_RUNS_MAX),
        mutants: z.array(validationMutantSchema).max(VALIDATION_MUTANTS_MAX),
    })
    .strict();
export type ValidationResult = z.infer<typeof validationResultSchema>;

export const validationCompleteRequestSchema = z
    .object({ lease_epoch: z.number().int().min(1), result: validationResultSchema })
    .strict();

// What the control plane stores and shows: one entry per check, in a fixed order.
export const validationCheckSchema = z
    .object({ name: z.string().max(100), ok: z.boolean(), detail: z.string().max(200) })
    .strict();
export type ValidationCheck = z.infer<typeof validationCheckSchema>;
