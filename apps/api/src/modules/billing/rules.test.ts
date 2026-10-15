// Goal: the two checks every feature uses fail closed. A switch that is off refuses; a limit allows the next use only while
// usage is below it (zero allows none); nonsense usage is a bug and stops loudly.
import type { Entitlements } from "@aura/contracts/api/billing";
import { describe, expect, it } from "vitest";
import { featureEnabled, withinLimit } from "./rules.ts";

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
