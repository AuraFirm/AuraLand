// Goal: the production random source must stay in range, reject bad bounds loudly, and be uniform.
// The uniformity check guards against the modulo/rounding bias CodeQL flagged (js/biased-
// cryptographic-random); its tolerance is about seven standard deviations, so it cannot flake.
import { describe, expect, it } from "vitest";
import { systemRng } from "./rng.ts";

describe("systemRng.nextInt", () => {
    it("stays in [0, bound) and returns 0 for bound 1", () => {
        for (let i = 0; i < 5_000; i++) {
            const value = systemRng.nextInt(7);
            expect(Number.isInteger(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(7);
        }
        expect(systemRng.nextInt(1)).toBe(0);
    });

    it("accepts the largest supported bound and rejects anything outside the contract", () => {
        expect(() => systemRng.nextInt(2 ** 48 - 1)).not.toThrow();
        for (const bad of [
            0,
            -1,
            1.5,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            2 ** 48,
            2 ** 48 + 1,
        ]) {
            expect(() => systemRng.nextInt(bad)).toThrow(/bound/);
        }
    });

    it("is uniform across buckets", () => {
        const draws = 30_000;
        const counts = [0, 0, 0];
        for (let i = 0; i < draws; i++) {
            const bucket = systemRng.nextInt(3);
            counts[bucket] = (counts[bucket] ?? 0) + 1;
        }
        for (const count of counts) expect(Math.abs(count - draws / 3)).toBeLessThan(600);
    });
});

describe("systemRng.nextFloat", () => {
    it("is in [0, 1)", () => {
        for (let i = 0; i < 5_000; i++) {
            const value = systemRng.nextFloat();
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
        }
    });
});

describe("systemRng.nextBytes", () => {
    it("returns exactly the requested number of bytes, different each time", () => {
        for (const count of [1, 16, 32, 1024])
            expect(systemRng.nextBytes(count).length).toBe(count);
        const first = Buffer.from(systemRng.nextBytes(32)).toString("hex");
        expect(Buffer.from(systemRng.nextBytes(32)).toString("hex")).not.toBe(first);
    });

    it("rejects counts outside 1 to 1024 and non-integers", () => {
        for (const bad of [0, -1, 1025, 1.5, Number.NaN])
            expect(() => systemRng.nextBytes(bad)).toThrow(/count/);
    });
});
