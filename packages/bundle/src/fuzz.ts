import { zstdCompressSync } from "node:zlib";
import { assert } from "@aura/contracts/assert";
import { corpusCases } from "./corpus.ts";
import { BUNDLE_ERROR_CODES } from "./errors.ts";
import { validateBundle } from "./validate.ts";

// A mutation fuzzer for the validator: take a corpus tar, damage it in a random way, pack it again
// and validate. The one property: the validator answers (success or a known code) and never throws,
// whatever the bytes. Seeded, so a failure replays from its seed and iteration number.

// splitmix32: tiny, fast and good enough to drive mutations. Not for anything secret.
function generator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x9e3779b9) >>> 0;
        let z = state;
        z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
        z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
        return (z ^ (z >>> 16)) >>> 0;
    };
}

const MUTATIONS = [
    "flip",
    "set",
    "insert",
    "delete",
    "truncate",
    "duplicate",
    "zero-block",
] as const;

function mutate(tar: Uint8Array, next: () => number): Uint8Array {
    const kind = MUTATIONS[next() % MUTATIONS.length];
    const at = tar.length === 0 ? 0 : next() % tar.length;
    const out = Array.from(tar);
    if (kind === "flip") out[at] = (out[at] ?? 0) ^ (1 << (next() % 8));
    else if (kind === "set") out[at] = next() & 0xff;
    else if (kind === "insert") out.splice(at, 0, next() & 0xff);
    else if (kind === "delete") out.splice(at, 1);
    else if (kind === "truncate") out.length = at;
    else if (kind === "duplicate") out.splice(at, 0, ...out.slice(at, at + 512));
    else out.splice(at - (at % 512), 0, ...new Array(512).fill(0));
    return Uint8Array.from(out);
}

// Most damaged headers die at the checksum, which hides the checks behind it. Half the time this
// rewrites the checksum of every block that still looks like a header, so mutations reach them.
function repairChecksums(tar: Uint8Array): Uint8Array {
    const out = Uint8Array.from(tar);
    for (let start = 0; start + 512 <= out.length; start += 512) {
        const header = out.subarray(start, start + 512);
        if (header[257] !== 0x75 || header[258] !== 0x73) continue; // "us" of "ustar"
        header.fill(0x20, 148, 156);
        const sum = header.reduce((total, byte) => total + byte, 0);
        const text = `${sum.toString(8).padStart(6, "0")}\0 `;
        header.set(
            Uint8Array.from(text, (character) => character.charCodeAt(0)),
            148,
        );
    }
    return out;
}

export interface FuzzReport {
    readonly iterations: number;
    readonly accepted: number;
    readonly codes: Readonly<Record<string, number>>;
}

// Throws (with the seed and iteration) on the first input that makes the validator throw or give an
// answer outside the closed set.
export function fuzzValidator(seed: number, iterations: number): FuzzReport {
    assert(iterations >= 1 && Number.isSafeInteger(seed), "a positive count and an integer seed");
    const next = generator(seed);
    const sources = corpusCases().filter((c) => !c.raw && c.tar.length < 64 * 1024);
    const codes: Record<string, number> = {};
    let accepted = 0;
    for (let iteration = 0; iteration < iterations; iteration++) {
        const source = sources[next() % sources.length];
        assert(source !== undefined, "the corpus has sources");
        let tar = source.tar;
        const rounds = 1 + (next() % 3);
        for (let round = 0; round < rounds; round++) tar = mutate(tar, next);
        if (next() % 2 === 0) tar = repairChecksums(tar);
        // One input in eight skips compression, so the decompressor sees raw damage too.
        const packed =
            next() % 8 === 0 ? tar : new Uint8Array(zstdCompressSync(tar, { params: { 100: 1 } }));
        try {
            const result = validateBundle(packed);
            if (result.ok) accepted++;
            else {
                assert(BUNDLE_ERROR_CODES.includes(result.error.code), "a known refusal code");
                codes[result.error.code] = (codes[result.error.code] ?? 0) + 1;
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`validator threw: seed=${seed} iteration=${iteration}: ${message}`);
        }
    }
    return { iterations, accepted, codes };
}
