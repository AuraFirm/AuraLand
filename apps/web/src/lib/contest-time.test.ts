import { describe, expect, it } from "vitest";
import { countdownLabel, countdownText } from "./contest-time.ts";

describe("countdownText", () => {
    it("shows a clock below a day, days beyond, rounds down and never goes negative", () => {
        expect(countdownText(0)).toBe("00:00:00");
        expect(countdownText(999)).toBe("00:00:00");
        expect(countdownText(61_000)).toBe("00:01:01");
        expect(countdownText(3_723_999)).toBe("01:02:03");
        expect(countdownText(86_400_000)).toBe("1 day 00:00:00");
        expect(countdownText(2 * 86_400_000 + 3_661_000)).toBe("2 days 01:01:01");
        expect(countdownText(-5000)).toBe("00:00:00");
    });
});

describe("countdownLabel", () => {
    const contest = { starts_at: "2026-10-14T10:00:00.000Z", ends_at: "2026-10-14T15:00:00.000Z" };
    const at = (iso: string) => Date.parse(iso);
    it("counts to the start, then to the end, then says nothing", () => {
        expect(countdownLabel(contest, at("2026-10-14T09:59:00.000Z"))).toBe("Starts in 00:01:00");
        expect(countdownLabel(contest, at("2026-10-14T10:00:00.000Z"))).toBe("Ends in 05:00:00");
        expect(countdownLabel(contest, at("2026-10-14T14:59:59.000Z"))).toBe("Ends in 00:00:01");
        expect(countdownLabel(contest, at("2026-10-14T15:00:00.000Z"))).toBeNull();
    });
});
