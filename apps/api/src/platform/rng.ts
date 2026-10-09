import { randomBytes } from "node:crypto";
import { assert } from "@aura/contracts/assert";

// All randomness flows through this port so simulation can replay a run from a seed.

export interface Rng {
    // Uniform float in [0, 1).
    nextFloat(): number;
    // Uniform integer in [0, boundExclusive).
    nextInt(boundExclusive: number): number;
}

function nextFloatSystem(): number {
    // 32 random bits give 2^32 equally likely values, which is plenty of resolution here.
    return randomBytes(4).readUInt32BE(0) / 2 ** 32;
}

// Production randomness uses the operating system CSPRNG, never Math.random.
export const systemRng: Rng = {
    nextFloat: nextFloatSystem,
    nextInt(boundExclusive: number): number {
        assert(Number.isSafeInteger(boundExclusive), "bound must be a safe integer");
        assert(boundExclusive > 0, "bound must be positive");
        return Math.floor(nextFloatSystem() * boundExclusive);
    },
};
