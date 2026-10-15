// Goal: the two checks every feature uses fail closed. A switch that is off refuses; a limit allows the next use only while
// usage is below it (zero allows none); nonsense usage is a bug and stops loudly.
import type { Entitlements } from "@aura/contracts/api/billing";
import { describe, expect, it } from "vitest";
import { featureEnabled, monthBoundsUtc, previousMonthUtc, withinLimit } from "./rules.ts";

const free: Entitlements = {
    plan: "free",
    name: "Free",
    members_max: 5,
    env_runs_per_month: 20,
    verifications_per_month: 100,
    webhook_endpoints_max: 0,
    sso: false,
    scim: false,
    employer_search: false,
};

describe("featureEnabled", () => {
    it("is true only for a switch that is on", () => {
        expect(featureEnabled(free, "sso")).toBe(false);
        expect(featureEnabled({ ...free, sso: true }, "sso")).toBe(true);
        expect(featureEnabled({ ...free, sso: true }, "scim")).toBe(false);
    });
});

describe("withinLimit", () => {
    it("allows the next use while usage is below the limit, and not at it", () => {
        expect(withinLimit(free, "members_max", 4)).toBe(true);
        expect(withinLimit(free, "members_max", 5)).toBe(false);
        expect(withinLimit(free, "members_max", 6)).toBe(false);
    });
    it("a limit of zero allows nothing", () => {
        expect(withinLimit(free, "webhook_endpoints_max", 0)).toBe(false);
    });
    it("refuses nonsense usage loudly", () => {
        expect(() => withinLimit(free, "members_max", -1)).toThrow();
        expect(() => withinLimit(free, "members_max", 1.5)).toThrow();
    });
});

describe("monthBoundsUtc", () => {
    it("is the calendar month in UTC, start included and end excluded", () => {
        const midMonth = Date.UTC(2026, 9, 15, 12);
        expect(monthBoundsUtc(midMonth)).toEqual({
            startMs: Date.UTC(2026, 9, 1),
            endMs: Date.UTC(2026, 10, 1),
        });
        expect(monthBoundsUtc(Date.UTC(2026, 9, 1)).startMs).toBe(Date.UTC(2026, 9, 1));
        // The last millisecond still belongs to October; the next one is November.
        expect(monthBoundsUtc(Date.UTC(2026, 10, 1) - 1).startMs).toBe(Date.UTC(2026, 9, 1));
        expect(monthBoundsUtc(Date.UTC(2026, 10, 1)).startMs).toBe(Date.UTC(2026, 10, 1));
    });
    it("rolls over the year", () => {
        expect(monthBoundsUtc(Date.UTC(2026, 11, 31, 23, 59)).endMs).toBe(Date.UTC(2027, 0, 1));
    });
    it("refuses a time that is not a time", () => {
        expect(() => monthBoundsUtc(Number.NaN)).toThrow();
        expect(() => monthBoundsUtc(-1)).toThrow();
    });
});

describe("previousMonthUtc", () => {
    it("is the month before, labelled, across a year end", () => {
        expect(previousMonthUtc(Date.UTC(2026, 9, 15))).toEqual({
            startMs: Date.UTC(2026, 8, 1),
            endMs: Date.UTC(2026, 9, 1),
            period: "2026-09",
        });
        expect(previousMonthUtc(Date.UTC(2027, 0, 1))).toMatchObject({
            startMs: Date.UTC(2026, 11, 1),
            period: "2026-12",
        });
    });
});
