// Goal: a TaskSpec is accepted only when it is complete, bounded and consistent, and an unknown or
// unsupported field fails loudly. The boundary cases sit exactly on each limit.
import { describe, expect, it } from "vitest";
import {
    MEMORY_LIMIT_KIB_MAX,
    MEMORY_LIMIT_KIB_MIN,
    STATEMENT_BYTES_MAX,
    TIME_LIMIT_MS_MAX,
    TIME_LIMIT_MS_MIN,
} from "./limits.ts";
import { statementSchema, taskSlugSchema, taskSpecSchema, VERSION_STATES } from "./tasks.ts";

const valid = {
    spec_version: 1,
    kind: "algorithmic",
    title: "Sum of two numbers",
    time_limit_ms: 1000,
    memory_limit_kib: 262144,
    output_limit_kib: 1024,
    languages: ["cpp", "python3"],
    scoring: { type: "subtasks", subtasks: [{ group: "small", points: 40 }] },
    tests: [
        { id: "001", group: "small", points: 40, is_sample: true },
        { id: "002", group: "large", points: 60, is_sample: false },
    ],
    checker: { type: "exact" },
    license: { owner: "Acme", terms: "internal use" },
    provenance: { author: "Alice", created: "2026-10-10", generated_with_ai: false },
};

const parse = (change: Record<string, unknown>) =>
    taskSpecSchema.safeParse({ ...valid, ...change });

describe("taskSpecSchema", () => {
    it("accepts a complete spec and fills the defaults", () => {
        const spec = taskSpecSchema.parse(valid);
        expect(spec.interactive).toBe(false);
        expect(spec.provenance.reviewers).toEqual([]);
    });

    it("rejects unknown fields and unsupported kinds", () => {
        expect(parse({ extra: 1 }).success).toBe(false);
        expect(parse({ kind: "sql" }).success).toBe(false);
        expect(parse({ spec_version: 2 }).success).toBe(false);
        expect(parse({ checker: { type: "exact", cmd: "x" } }).success).toBe(false);
    });

    it("accepts the limits exactly and refuses one step beyond", () => {
        expect(parse({ time_limit_ms: TIME_LIMIT_MS_MIN }).success).toBe(true);
        expect(parse({ time_limit_ms: TIME_LIMIT_MS_MIN - 1 }).success).toBe(false);
        expect(parse({ time_limit_ms: TIME_LIMIT_MS_MAX }).success).toBe(true);
        expect(parse({ time_limit_ms: TIME_LIMIT_MS_MAX + 1 }).success).toBe(false);
        expect(parse({ memory_limit_kib: MEMORY_LIMIT_KIB_MIN }).success).toBe(true);
        expect(parse({ memory_limit_kib: MEMORY_LIMIT_KIB_MAX + 1 }).success).toBe(false);
        expect(parse({ time_limit_ms: 1000.5 }).success).toBe(false);
    });

    it("rejects specs that cannot be scored", () => {
        const tests = valid.tests;
        expect(parse({ tests: [...tests, { ...tests[0] }] }).success).toBe(false);
        expect(
            parse({ scoring: { type: "subtasks", subtasks: [{ group: "none", points: 1 }] } })
                .success,
        ).toBe(false);
        expect(parse({ scoring: { type: "subtasks", subtasks: [] } }).success).toBe(false);
        expect(parse({ tests: [] }).success).toBe(false);
        expect(parse({ languages: [] }).success).toBe(false);
    });

    it("keeps file-like names safe", () => {
        const bad = { id: "../x", group: "g", points: 1, is_sample: false };
        expect(parse({ tests: [bad] }).success).toBe(false);
        expect(parse({ tests: [{ ...bad, id: "a/b" }] }).success).toBe(false);
    });
});

describe("statement and slug", () => {
    it("counts statement size in bytes", () => {
        expect(statementSchema.safeParse("a".repeat(STATEMENT_BYTES_MAX)).success).toBe(true);
        expect(statementSchema.safeParse("a".repeat(STATEMENT_BYTES_MAX + 1)).success).toBe(false);
        // Three bytes per character: 21,846 characters is 65,538 bytes.
        expect(statementSchema.safeParse("€".repeat(21_846)).success).toBe(false);
        expect(statementSchema.safeParse("").success).toBe(false);
    });

    it("applies the slug rules", () => {
        expect(taskSlugSchema.safeParse("two-sum").success).toBe(true);
        expect(taskSlugSchema.safeParse("ab").success).toBe(false);
        expect(taskSlugSchema.safeParse("-bad").success).toBe(false);
        expect(taskSlugSchema.safeParse("a".repeat(41)).success).toBe(false);
    });

    it("has a closed state list that starts at draft", () => {
        expect(VERSION_STATES[0]).toBe("draft");
    });
});
