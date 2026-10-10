import { assert } from "@aura/contracts/assert";

// Writes the one tar form the validator accepts, and (for the corpus) deliberately broken variants.
// Canonical means: ustar, regular files only, sorted by path, no prefix field, owner and group 0
// with no names, mode 0644, modification time 0. Two bundles with the same files are the same bytes,
// which is what lets the content hash mean something (docs/kit/07 section 7).

export const BLOCK = 512;

export interface HeaderFields {
    name: string;
    size: number;
    typeflag: string;
    mode: string;
    uid: string;
    gid: string;
    mtime: string;
    linkname: string;
    magic: string;
    version: string;
    uname: string;
    gname: string;
    devmajor: string;
    devminor: string;
    prefix: string;
    // A string forces that text into the size field instead of the octal size.
    sizeText: string | null;
}

export function canonicalFields(name: string, size: number): HeaderFields {
    return {
        name,
        size,
        typeflag: "0",
        mode: "0000644\0",
        uid: "0000000\0",
        gid: "0000000\0",
        mtime: "00000000000\0",
        linkname: "",
        magic: "ustar\0",
        version: "00",
        uname: "",
        gname: "",
        devmajor: "0000000\0",
        devminor: "0000000\0",
        prefix: "",
        sizeText: null,
    };
}

function put(block: Uint8Array, offset: number, length: number, text: string): void {
    // One byte per character, so a corpus case can place any byte value where it wants it.
    const bytes = Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff);
    assert(bytes.length <= length, "field text fits its field");
    block.set(bytes, offset);
}

// `checksum: "auto"` computes a correct one; a string writes that text instead (for corruption).
export function headerBlock(fields: HeaderFields, checksum: "auto" | string = "auto"): Uint8Array {
    const block = new Uint8Array(BLOCK);
    put(block, 0, 100, fields.name);
    put(block, 100, 8, fields.mode);
    put(block, 108, 8, fields.uid);
    put(block, 116, 8, fields.gid);
    put(block, 124, 12, fields.sizeText ?? `${fields.size.toString(8).padStart(11, "0")}\0`);
    put(block, 136, 12, fields.mtime);
    block.fill(0x20, 148, 156);
    put(block, 156, 1, fields.typeflag);
    put(block, 157, 100, fields.linkname);
    put(block, 257, 6, fields.magic);
    put(block, 263, 2, fields.version);
    put(block, 265, 32, fields.uname);
    put(block, 297, 32, fields.gname);
    put(block, 329, 8, fields.devmajor);
    put(block, 337, 8, fields.devminor);
    put(block, 345, 155, fields.prefix);
    const sum = block.reduce((total, byte) => total + byte, 0);
    put(block, 148, 8, checksum === "auto" ? `${sum.toString(8).padStart(6, "0")}\0 ` : checksum);
    return block;
}

export interface TarFile {
    readonly path: string;
    readonly data: Uint8Array;
}

export function paddedData(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
    out.set(data);
    return out;
}

export const ZERO_BLOCKS = (count: number): Uint8Array => new Uint8Array(BLOCK * count);

export function concat(parts: readonly Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

// The canonical tar of these files. Paths are sorted here, so callers need not.
export function buildTar(files: readonly TarFile[]): Uint8Array {
    const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const parts: Uint8Array[] = [];
    for (const file of sorted) {
        parts.push(headerBlock(canonicalFields(file.path, file.data.length)));
        parts.push(paddedData(file.data));
    }
    parts.push(ZERO_BLOCKS(2));
    return concat(parts);
}
