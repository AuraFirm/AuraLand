import { randomBytes, randomInt } from "node:crypto";
import { assert } from "@aura/contracts/assert";

// All randomness flows through this port so simulation can replay a run from a seed.

export interface Rng {
    // Uniform float in [0, 1).
    nextFloat(): number;
    // Uniform integer in [0, boundExclusive).
    nextInt(boundExclusive: number): number;
}

// node:crypto.randomInt accepts a maximum of 2^48 - 1.
const BOUND_EXCLUSIVE_MAX = 2 ** 48 - 1;

function nextFloatSystem(): number {
    // 32 random bits give 2^32 equally likely values, which is plenty of resolution here.
    return randomBytes(4).readUInt32BE(0) / 2 ** 32;
}

// Production randomness uses the operating system CSPRNG, never Math.random. nextInt uses
// randomInt, which rejects out-of-range draws; scaling a float and rounding would bias results
// toward some values (CodeQL js/biased-cryptographic-random).
export const systemRng: Rng = {
    nextFloat: nextFloatSystem,
    nextInt(boundExclusive: number): number {
        assert(Number.isSafeInteger(boundExclusive), "bound must be a safe integer");
        assert(boundExclusive > 0, "bound must be positive");
        assert(boundExclusive <= BOUND_EXCLUSIVE_MAX, "bound must not exceed 2^48 - 1");
        return randomInt(boundExclusive);
    },
};
