// Goal: the cost report adds up, never divides by zero, says which kinds it could not price, and refuses nonsense inputs.
import { describe, expect, it } from "vitest";
import { costReport } from "./cost-per-verification.ts";

const costs = {
    currency: "USD",
    perEvent: { env_run: 10, employer_report: 2 },
    fixedPerMonth: 1000,
};

describe("costReport", () => {
    it("adds variable and fixed cost and divides by the events", () => {
        expect(costReport({ env_run: 30, employer_report: 50 }, costs)).toEqual({
            currency: "USD",
            events: 80,
            variableMinor: 400,
            fixedMinor: 1000,
            totalMinor: 1400,
            perEventMinor: 17.5,
            unpriced: [],
        });
    });
    it("has no per-event cost when nothing happened", () => {
        expect(costReport({}, costs)).toMatchObject({
            events: 0,
            totalMinor: 1000,
            perEventMinor: null,
        });
    });
    it("names kinds it cannot price and leaves them out of the count", () => {
        expect(costReport({ env_run: 1, mystery: 5 }, costs)).toMatchObject({
            events: 1,
            unpriced: ["mystery"],
        });
    });
    it("refuses negative or fractional counts and costs", () => {
        expect(() => costReport({ env_run: -1 }, costs)).toThrow();
        expect(() => costReport({ env_run: 1.5 }, costs)).toThrow();
        expect(() => costReport({ env_run: 1 }, { ...costs, perEvent: { env_run: -2 } })).toThrow();
    });
});
