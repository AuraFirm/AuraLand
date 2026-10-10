import { assert } from "@aura/contracts/assert";
import { type BundleResult, fail, succeed } from "./errors.ts";
import { isSafeEntryPath } from "./paths.ts";
import { BLOCK, canonicalFields, headerBlock } from "./tar-writer.ts";

// A strict reader for the canonical tar form (see tar-writer.ts). It accepts exactly what the writer
// produces and refuses everything else with a specific code, because a lenient tar reader is where
// archive attacks live. The input is untrusted; this code never touches disk, spawns anything or
// follows a path. When a header has several defects the first in this order wins, so the answer is
// stable: checksum, entry type, path, entry count, size, canonical form, data and padding, order.

export interface TarEntry {
    readonly path: string;
    readonly data: Uint8Array;
}

export interface TarLimits {
    readonly entriesMax: number;
    readonly fileBytesMax: number;
}

const SIZE_FIELD = /^[0-7]{11}\0$/;
const CHECKSUM_FIELD = /^[0-7]{6}\0 $/;
const ASCII = new TextDecoder("ascii");

const isZero = (block: Uint8Array): boolean => block.every((byte) => byte === 0);
const text = (block: Uint8Array, start: number, end: number): string =>
    ASCII.decode(block.subarray(start, end));

function checksumOf(header: Uint8Array): number {
    let sum = 0;
    for (let index = 0; index < BLOCK; index++) {
        sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
    }
    return sum;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

// The name field: bytes up to the first NUL, and nothing but NUL after it.
function nameOf(header: Uint8Array): string | null {
    const field = header.subarray(0, 100);
    const end = field.indexOf(0);
    const length = end === -1 ? field.length : end;
    if (!field.subarray(length).every((byte) => byte === 0)) return null;
    // Non-ASCII bytes decode to U+FFFD or Latin-1 letters, both rejected by the path allowlist.
    return text(field, 0, length);
}

function readTrailer(tar: Uint8Array, position: number): BundleResult<null> {
    if (position + BLOCK >= tar.length) return fail("bad_trailer", "only one zero block");
    if (position + 2 * BLOCK !== tar.length) return fail("bad_trailer", "bytes after the trailer");
    return isZero(tar.subarray(position + BLOCK))
        ? succeed(null)
        : fail("bad_trailer", "second trailer block is not zero");
}

type HeaderResult = BundleResult<{ readonly path: string; readonly size: number }>;

function readHeader(header: Uint8Array, count: number, limits: TarLimits): HeaderResult {
    const stored = text(header, 148, 156);
    if (!CHECKSUM_FIELD.test(stored) || Number.parseInt(stored, 8) !== checksumOf(header)) {
        return fail("bad_checksum", "header checksum does not match");
    }
    const typeflag = header[156];
    if (typeflag !== 0x30) return fail("unsupported_entry", `entry type ${typeflag ?? -1}`);
    const path = nameOf(header);
    if (path === null || !isSafeEntryPath(path)) return fail("unsafe_path", "path is not allowed");
    if (count >= limits.entriesMax) return fail("too_many_entries", `over ${limits.entriesMax}`);
    const sizeText = text(header, 124, 136);
    if (!SIZE_FIELD.test(sizeText)) return fail("non_canonical_header", `${path}: size field`);
    const size = Number.parseInt(sizeText, 8);
    if (size > limits.fileBytesMax) return fail("file_too_large", path);
    if (!sameBytes(header, headerBlock(canonicalFields(path, size)))) {
        return fail("non_canonical_header", `${path}: header differs from canonical form`);
    }
    return succeed({ path, size });
}

export function readTar(tar: Uint8Array, limits: TarLimits): BundleResult<TarEntry[]> {
    assert(limits.entriesMax >= 1 && limits.fileBytesMax >= 0, "limits are positive");
    const entries: TarEntry[] = [];
    const seenLowerCase = new Set<string>();
    let position = 0;
    // Each pass consumes at least one block, so the loop ends within tar.length / BLOCK passes.
    while (position < tar.length) {
        if (position + BLOCK > tar.length) return fail("truncated", "tar ends inside a header");
        const header = tar.subarray(position, position + BLOCK);
        if (isZero(header)) {
            const trailer = readTrailer(tar, position);
            return trailer.ok ? succeed(entries) : trailer;
        }
        const parsed = readHeader(header, entries.length, limits);
        if (!parsed.ok) return parsed;
        const { path, size } = parsed.value;
        const dataStart = position + BLOCK;
        const dataEnd = dataStart + size;
        const paddedEnd = dataStart + Math.ceil(size / BLOCK) * BLOCK;
        if (paddedEnd > tar.length) return fail("truncated", `${path}: tar ends inside the data`);
        if (!tar.subarray(dataEnd, paddedEnd).every((byte) => byte === 0)) {
            return fail("bad_padding", path);
        }
        if (seenLowerCase.has(path.toLowerCase())) return fail("duplicate_path", path);
        const previous = entries[entries.length - 1];
        if (previous !== undefined && path < previous.path) return fail("unsorted_entries", path);
        seenLowerCase.add(path.toLowerCase());
        entries.push({ path, data: tar.subarray(dataStart, dataEnd) });
        position = paddedEnd;
    }
    return fail("truncated", "tar has no trailer");
}
