// Goal: the Passport vocabulary keeps credentials small and honest. Method: band edges at the instant below and at
// each boundary, claim schemas refuse anything extra, and a contest claim cannot pass as an exam claim.

import { describe, expect, it } from "vitest";
import { credentialClaimSchema, pointsBand } from "./credentials.ts";

describe("pointsBand", () => {
    it("moves up exactly at 25, 50 and 75 percent", () => {
        const cases: [number, string][] = [
            [0, "0-24"],
            [24.99, "0-24"],
            [25, "25-49"],
            [49.99, "25-49"],
            [50, "50-74"],
            [74.99, "50-74"],
            [75, "75-100"],
            [100, "75-100"],
        ];
        for (const [points, band] of cases)
            expect(pointsBand(points, 100), String(points)).toBe(band);
    });

    it("refuses points outside the exam", () => {
        expect(() => pointsBand(101, 100)).toThrow();
        expect(() => pointsBand(-1, 100)).toThrow();
        expect(() => pointsBand(1, 0)).toThrow();
    });
});

describe("credential claims", () => {
    const exam = {
        kind: "exam_result",
        event_title: "Lab exam",
        host_name: "Uni",
        points_band: "75-100",
        ai_mode: "ai_free",
        released_at: "2026-10-15T10:00:00.000Z",
    };
    const contest = {
        kind: "contest_rank",
        event_title: "Weekly",
        host_name: "Uni",
        rank: 3,
        participants: 120,
        solved: 4,
        finalized_at: "2026-10-15T10:00:00.000Z",
    };

    it("accepts a well-formed claim of each kind", () => {
        expect(credentialClaimSchema.parse(exam).kind).toBe("exam_result");
        expect(credentialClaimSchema.parse(contest).kind).toBe("contest_rank");
    });

    it("refuses extra fields, wrong bands, and one kind wearing the other's fields", () => {
        expect(credentialClaimSchema.safeParse({ ...exam, email: "a@b.c" }).success).toBe(false);
        expect(credentialClaimSchema.safeParse({ ...exam, points_band: "80-100" }).success).toBe(
            false,
        );
        expect(credentialClaimSchema.safeParse({ ...exam, points: 93 }).success).toBe(false);
        expect(credentialClaimSchema.safeParse({ ...contest, rank: 0 }).success).toBe(false);
        expect(credentialClaimSchema.safeParse({ ...exam, kind: "contest_rank" }).success).toBe(
            false,
        );
    });
});
