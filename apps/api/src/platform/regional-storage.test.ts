// Goal: each region reaches its own storage and only its own; a region without storage fails loudly instead of using another one;
// nonsense region names fail the same way.
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../sim/world.ts";
import { createRegionalStorage, RegionNotConfiguredError } from "./regional-storage.ts";
import { createMemoryStorage } from "./storage-memory.ts";

const clock = createFakeClock(1_800_000_000_000);

describe("createRegionalStorage", () => {
    const eu = createMemoryStorage(clock);
    const us = createMemoryStorage(clock);
    const storage = createRegionalStorage({ eu, us });

    it("routes each region to its own storage", () => {
        expect(storage.forRegion("eu")).toBe(eu);
        expect(storage.forRegion("us")).toBe(us);
        expect(storage.regions).toEqual(["eu", "us"]);
    });

    it("never falls back: a region with no storage, or no such region, is an error", () => {
        expect(() => storage.forRegion("ap")).toThrow(RegionNotConfiguredError);
        for (const name of ["", "EU", "mars", "eu "])
            expect(() => storage.forRegion(name), name).toThrow(RegionNotConfiguredError);
    });

    it("keeps the regions apart: a file written in one is not in the other", async () => {
        await storage.forRegion("eu").putSmall("k", new Uint8Array([1]), "text/plain");
        expect((await storage.forRegion("us").getSmall("k", 10)).kind).toBe("missing");
        expect((await storage.forRegion("eu").getSmall("k", 10)).kind).toBe("found");
    });

    it("needs at least one region", () => {
        expect(() => createRegionalStorage({})).toThrow();
    });
});
