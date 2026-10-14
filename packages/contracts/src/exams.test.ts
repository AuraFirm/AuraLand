import { describe, expect, it } from "vitest";
import {
    EXAM_MODES,
    EXAM_STATES,
    examCreateRequestSchema,
    rosterRowSchema,
    SESSION_STATES,
    TELEMETRY_KINDS,
    telemetryKindSchema,
} from "./exams.ts";

const problem = {
    label: "A",
    task_version_id: "tsv_x",
    points: 100,
    auto_percent: 70,
    rubric: [{ id: "style", label: "Readable code", max_points: 30 }],
};
const exam = {
    title: "Lab 3",
    mode: "ai_free",
    duration_s: 7200,
    window_start: "2026-11-01T09:00:00Z",
    window_end: "2026-11-01T13:00:00Z",
    problems: [problem],
};

describe("examCreateRequestSchema", () => {
    it("accepts a normal exam and fills the defaults", () => {
        const parsed = examCreateRequestSchema.parse(exam);
        expect(parsed.assurance_level).toBe(1);
        expect(parsed.telemetry_retention_days).toBe(180);
    });

    it("refuses assurance levels that are not built", () => {
        expect(examCreateRequestSchema.safeParse({ ...exam, assurance_level: 2 }).success).toBe(
            false,
        );
    });

    it("needs a window that holds the duration and is at most a week, at the boundaries", () => {
        const window = (seconds: number) => ({
            ...exam,
            duration_s: 7200,
            window_end: new Date(Date.parse(exam.window_start) + seconds * 1000).toISOString(),
        });
        expect(examCreateRequestSchema.safeParse(window(7200)).success).toBe(true);
        expect(examCreateRequestSchema.safeParse(window(7199)).success).toBe(false);
        expect(examCreateRequestSchema.safeParse(window(7 * 86_400)).success).toBe(true);
        expect(examCreateRequestSchema.safeParse(window(7 * 86_400 + 1)).success).toBe(false);
    });

    it("bounds the duration at five minutes and eight hours", () => {
        const w = { window_end: "2026-11-09T00:00:00Z" };
        for (const [duration, ok] of [
            [299, false],
            [300, true],
            [28_800, true],
            [28_801, false],
        ] as const) {
            expect(
                examCreateRequestSchema.safeParse({
                    ...exam,
                    ...w,
                    window_end: "2026-11-02T00:00:00Z",
                    duration_s: duration,
                }).success,
            ).toBe(ok);
        }
    });
});

describe("examCreateRequestSchema rubric and shape", () => {
    it("requires the rubric to carry exactly the points the judge does not decide", () => {
        const withRubric = (points: number) => ({
            ...exam,
            problems: [{ ...problem, rubric: [{ id: "a", label: "x", max_points: points }] }],
        });
        expect(examCreateRequestSchema.safeParse(withRubric(30)).success).toBe(true);
        expect(examCreateRequestSchema.safeParse(withRubric(29)).success).toBe(false);
        expect(examCreateRequestSchema.safeParse(withRubric(31)).success).toBe(false);
        const allAuto = { ...exam, problems: [{ ...problem, auto_percent: 100, rubric: [] }] };
        expect(examCreateRequestSchema.safeParse(allAuto).success).toBe(true);
    });

    it("refuses duplicate labels and rubric ids, no problems, too many, and unknown fields", () => {
        expect(
            examCreateRequestSchema.safeParse({ ...exam, problems: [problem, problem] }).success,
        ).toBe(false);
        expect(examCreateRequestSchema.safeParse({ ...exam, problems: [] }).success).toBe(false);
        expect(examCreateRequestSchema.safeParse({ ...exam, extra: 1 }).success).toBe(false);
        const twice = {
            ...problem,
            points: 100,
            auto_percent: 40,
            rubric: [
                { id: "a", label: "x", max_points: 30 },
                { id: "a", label: "y", max_points: 30 },
            ],
        };
        expect(examCreateRequestSchema.safeParse({ ...exam, problems: [twice] }).success).toBe(
            false,
        );
    });
});

describe("rosterRowSchema", () => {
    it("lower-cases the email and bounds the accommodation", () => {
        expect(rosterRowSchema.parse({ email: " Ada@Example.COM ", name: "Ada" })).toEqual({
            email: "ada@example.com",
            name: "Ada",
            extra_minutes: 0,
        });
        expect(
            rosterRowSchema.safeParse({ email: "a@b.co", name: "A", extra_minutes: 480 }).success,
        ).toBe(true);
        expect(
            rosterRowSchema.safeParse({ email: "a@b.co", name: "A", extra_minutes: 481 }).success,
        ).toBe(false);
        expect(rosterRowSchema.safeParse({ email: "not an email", name: "A" }).success).toBe(false);
    });
});

describe("the vocabularies", () => {
    it("are closed and ordered as the kit says", () => {
        expect([...EXAM_MODES]).toEqual(["ai_free", "ai_allowed_logged"]);
        expect([...EXAM_STATES]).toEqual(["draft", "scheduled", "open", "closed", "released"]);
        expect([...SESSION_STATES]).toEqual([
            "invited",
            "consented",
            "started",
            "submitted",
            "expired",
        ]);
    });

    it("refuse a telemetry kind that is not on the list", () => {
        for (const kind of TELEMETRY_KINDS)
            expect(telemetryKindSchema.safeParse(kind).success).toBe(true);
        for (const kind of ["screenshot", "keystroke", "webcam", "audio", "ai_text_score"]) {
            expect(telemetryKindSchema.safeParse(kind).success).toBe(false);
        }
    });
});
