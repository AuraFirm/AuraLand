// Goal: the simulation harness must be deterministic and must surface bugs with a replayable seed.
import { describe, expect, it } from "vitest";
import { runScenario, runSeeds } from "./runner.ts";
import { boundedQueueScenario } from "./selftest.sim.ts";
import { createFakeClock, createSeededRng } from "./world.ts";

describe("seeded rng", () => {
    it("is reproducible for a seed and different across seeds", () => {
        const draw = (seed: number) => {
            const rng = createSeededRng(seed);
            return Array.from({ length: 5 }, () => rng.nextInt(1_000_000));
        };
        expect(draw(42)).toEqual(draw(42));
        expect(draw(42)).not.toEqual(draw(43));
    });

    it("stays within bounds, including bound 1", () => {
        const rng = createSeededRng(7);
        for (let i = 0; i < 10_000; i++) {
            const value = rng.nextInt(3);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(3);
            expect(rng.nextFloat()).toBeLessThan(1);
        }
        expect(rng.nextInt(1)).toBe(0);
        expect(() => rng.nextInt(0)).toThrow(/positive/);
        expect(() => createSeededRng(-1)).toThrow(/seed/);
    });
});

describe("fake clock", () => {
    it("only moves forward", () => {
        const clock = createFakeClock(1000);
        clock.advance(5);
        expect(clock.nowUnixMs()).toBe(1005);
        expect(() => clock.advance(-1)).toThrow(/forward/);
    });
});

describe("runner", () => {
    it("passes the correct queue on 500 seeds", () => {
        expect(runSeeds(boundedQueueScenario(false), 0, 500)).toEqual([]);
    });

    it("finds the seeded bug and reproduces the identical failure from the seed", () => {
        const buggy = boundedQueueScenario(true);
        const failures = runSeeds(buggy, 0, 500);
        expect(failures.length).toBeGreaterThan(0);
        const first = failures[0];
        expect(first?.message).toMatch(/capacity/);
        const replay = runScenario(buggy, first?.seed ?? -1);
        expect(replay).toEqual(first);
    });
});
