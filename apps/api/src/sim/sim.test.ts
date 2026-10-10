// Goal: the simulation harness must be deterministic and must surface bugs with a replayable seed.
import { describe, expect, it } from "vitest";
import { loginScenario } from "./login.sim.ts";
import { runScenario, runSeeds } from "./runner.ts";
import { boundedQueueScenario } from "./selftest.sim.ts";
import { sessionScenario } from "./sessions.sim.ts";
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

describe("seeded rng bytes", () => {
    it("is reproducible per seed, differs across seeds and fills the requested length", () => {
        const bytes = (seed: number) =>
            Buffer.from(createSeededRng(seed).nextBytes(32)).toString("hex");
        expect(bytes(5)).toBe(bytes(5));
        expect(bytes(5)).not.toBe(bytes(6));
        expect(createSeededRng(1).nextBytes(7).length).toBe(7);
        expect(() => createSeededRng(1).nextBytes(0)).toThrow(/count/);
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
    it("passes the correct queue on 500 seeds", async () => {
        expect(await runSeeds(boundedQueueScenario(false), 0, 500)).toEqual([]);
    });

    it("finds the seeded bug and reproduces the identical failure from the seed", async () => {
        const buggy = boundedQueueScenario(true);
        const failures = await runSeeds(buggy, 0, 500);
        expect(failures.length).toBeGreaterThan(0);
        const first = failures[0];
        expect(first?.message).toMatch(/capacity/);
        const replay = await runScenario(buggy, first?.seed ?? -1);
        expect(replay).toEqual(first);
    });
});

describe("sessions scenario", () => {
    it("passes on 150 seeds with the real service", async () => {
        const failures = await runSeeds(sessionScenario("none"), 0, 150);
        expect(failures.map((f) => `${f.seed}@${f.step}: ${f.message}`)).toEqual([]);
    });

    it("catches a service that forgets to revoke the old token on rotation", async () => {
        const failures = await runSeeds(sessionScenario("rotation_keeps_old_token"), 0, 150);
        expect(failures.length).toBeGreaterThan(0);
        expect(failures[0]?.message).toMatch(/model|stops working/);
    });
});

describe("login challenge scenario", () => {
    it("passes on 150 seeds with the real store", async () => {
        const failures = await runSeeds(loginScenario(), 0, 150);
        expect(failures.map((f) => `${f.seed}@${f.step}: ${f.message}`)).toEqual([]);
    });
});
