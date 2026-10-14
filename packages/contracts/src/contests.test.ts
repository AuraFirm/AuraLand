// Goal: the contest contract accepts exactly the contests Stage 5 supports and refuses the rest.
import { describe, expect, it } from "vitest";
import { CONTEST_STATES, contestCreateRequestSchema, contestRulesSchema } from "./contests.ts";

const base = {
    slug: "spring-open",
    title: "Spring Open",
    rules: { format: "icpc" },
    starts_at: "2026-11-01T10:00:00Z",
    ends_at: "2026-11-01T15:00:00Z",
};
const parse = (change: Record<string, unknown> = {}) =>
    contestCreateRequestSchema.safeParse({ ...base, ...change });

describe("contestCreateRequestSchema", () => {
    it("accepts a plain contest and fills in the defaults", () => {
        const result = parse();
        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.data.rules).toMatchObject({
            format: "icpc",
            penalty_minutes_per_wrong: 20,
            submit_interval_s: 10,
        });
        expect(result.data).toMatchObject({
            visibility: "public",
            ai_policy: "none",
            rated: false,
            freeze_at: null,
            problems: [],
        });
    });

    it("keeps the rules to the two formats and refuses unknown fields", () => {
        expect(parse({ rules: { format: "ioi" } }).success).toBe(true);
        expect(parse({ rules: { format: "cf_rated" } }).success).toBe(false);
        expect(parse({ rules: { format: "icpc", penalty_minutes_per_wrong: 121 } }).success).toBe(
            false,
        );
        expect(parse({ rules: { format: "ioi", penalty_minutes_per_wrong: 20 } }).success).toBe(
            false,
        );
        expect(parse({ extra: 1 }).success).toBe(false);
    });

    it("bounds the duration and puts the freeze strictly inside the contest", () => {
        expect(parse({ ends_at: "2026-11-01T10:04:59Z" }).success).toBe(false);
        expect(parse({ ends_at: "2026-11-01T10:05:00Z" }).success).toBe(true);
        expect(parse({ ends_at: "2026-11-09T10:00:00Z" }).success).toBe(false);
        expect(parse({ freeze_at: "2026-11-01T14:00:00Z" }).success).toBe(true);
        for (const freeze of [
            "2026-11-01T10:00:00Z",
            "2026-11-01T15:00:00Z",
            "2026-10-31T10:00:00Z",
        ]) {
            expect(parse({ freeze_at: freeze }).success).toBe(false);
        }
    });

    it("refuses duplicate or malformed problem labels and a bad slug", () => {
        const problem = (label: string) => ({ label, task_version_id: "tsv_x" });
        expect(parse({ problems: [problem("A"), problem("B")] }).success).toBe(true);
        expect(parse({ problems: [problem("A"), problem("A")] }).success).toBe(false);
        expect(parse({ problems: [problem("a")] }).success).toBe(false);
        expect(parse({ problems: [problem("ABCD")] }).success).toBe(false);
        expect(parse({ slug: "Bad Slug" }).success).toBe(false);
        expect(parse({ slug: "x" }).success).toBe(false);
    });
});

describe("contestRulesSchema and the states", () => {
    it("allows only languages the platform names, at least one", () => {
        expect(contestRulesSchema.safeParse({ format: "ioi", languages: [] }).success).toBe(false);
        expect(contestRulesSchema.safeParse({ format: "ioi", languages: ["rust"] }).success).toBe(
            false,
        );
        expect(
            contestRulesSchema.safeParse({ format: "ioi", languages: ["cpp", "python3"] }).success,
        ).toBe(true);
        // C and Java arrive with their judge profiles (slice 13); until then a contest cannot offer them.
        expect(contestRulesSchema.safeParse({ format: "ioi", languages: ["c"] }).success).toBe(
            false,
        );
    });

    it("lists the states in the order a contest moves through them", () => {
        expect([...CONTEST_STATES]).toEqual([
            "draft",
            "scheduled",
            "running",
            "frozen",
            "ended",
            "finalized",
        ]);
    });
});
