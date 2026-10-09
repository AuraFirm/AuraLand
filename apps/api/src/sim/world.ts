import { assert } from "@aura/contracts/assert";
import type { Clock } from "../platform/clock.ts";
import { assertBytesCount, type Rng } from "../platform/rng.ts";

// The simulated world: a controllable clock and a seeded random source. Everything a scenario
// does must flow through these two, so a failing seed replays the exact same run.

export interface FakeClock extends Clock {
    advance(ms: number): void;
}

export interface World {
    readonly seed: number;
    readonly clock: FakeClock;
    readonly rng: Rng;
}

export function createFakeClock(startUnixMs: number): FakeClock {
    assert(Number.isSafeInteger(startUnixMs) && startUnixMs >= 0, "start time is a valid instant");
    let nowUnixMs = startUnixMs;
    return {
        nowUnixMs: () => nowUnixMs,
        advance(ms: number): void {
            assert(Number.isSafeInteger(ms) && ms >= 0, "time only moves forward");
            nowUnixMs += ms;
        },
    };
}

// splitmix32 spreads a small seed over 128 bits of state so nearby seeds give unrelated runs.
function splitmix32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x9e3779b9) >>> 0;
        let z = state;
        z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
        z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
        return (z ^ (z >>> 16)) >>> 0;
    };
}

// sfc32: a small, fast, well-tested generator. Not for cryptography, which simulation never needs.
export function createSeededRng(seed: number): Rng {
    assert(Number.isSafeInteger(seed) && seed >= 0, "seed is a non-negative integer");
    const seedStream = splitmix32(seed);
    let a = seedStream();
    let b = seedStream();
    let c = seedStream();
    let d = seedStream();
    const nextUint32 = (): number => {
        const t = (((a + b) >>> 0) + d) >>> 0;
        d = (d + 1) >>> 0;
        a = b ^ (b >>> 9);
        b = (c + (c << 3)) >>> 0;
        c = ((c << 21) | (c >>> 11)) >>> 0;
        c = (c + t) >>> 0;
        return t;
    };
    return {
        nextFloat: () => nextUint32() / 2 ** 32,
        nextBytes(count: number): Uint8Array {
            assertBytesCount(count);
            const bytes = new Uint8Array(count);
            for (let index = 0; index < count; index++) bytes[index] = nextUint32() & 0xff;
            return bytes;
        },
        nextInt(boundExclusive: number): number {
            assert(Number.isSafeInteger(boundExclusive) && boundExclusive > 0, "bound is positive");
            return Math.floor((nextUint32() / 2 ** 32) * boundExclusive);
        },
    };
}

// Fixed start instant so runs never depend on the machine clock.
const SIM_START_UNIX_MS = 1_800_000_000_000;

export function createWorld(seed: number): World {
    return { seed, clock: createFakeClock(SIM_START_UNIX_MS), rng: createSeededRng(seed) };
}
