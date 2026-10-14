import { describe, expect, it } from "vitest";
import { RATING_TIER_COLORS, RATING_TIER_NAMES } from "./api/ratings.ts";
import { RATING_TIERS, ratingTierOf } from "./rating.ts";

describe("rating tiers", () => {
    it("match the closed sets the API parses, in order", () => {
        expect(RATING_TIERS.map((t) => t.name)).toEqual([...RATING_TIER_NAMES]);
        expect(RATING_TIERS.map((t) => t.color)).toEqual([...RATING_TIER_COLORS]);
    });

    it("pick the tier at and around each boundary", () => {
        expect(ratingTierOf(-500).name).toBe("Newcomer");
        expect(ratingTierOf(1199).name).toBe("Newcomer");
        expect(ratingTierOf(1200).name).toBe("Apprentice");
        expect(ratingTierOf(1500).name).toBe("Adept");
        expect(ratingTierOf(2399).name).toBe("Grandmaster");
        expect(ratingTierOf(2400).name).toBe("Legend");
        expect(ratingTierOf(5000).name).toBe("Legend");
    });
});
