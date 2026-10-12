import { createHash } from "node:crypto";
import type { BundleResult } from "./errors.ts";
import { type OpenedBundle, openBundle } from "./validate.ts";

// What a judge node learns from a bundle (Stage 4B). The node must not parse archives itself, so the
// parsing happens inside a box, and this module is the box's whole program: bundle bytes in, a flat
// stream out that the Go side reads without a tar reader or a JSON parser.
//
//   AURA-OPEN 1\n
//   <size> <sha256 hex> <path>\n<size raw bytes>\n      once per file under tests/ or solutions/
//   END <count>\n
// or, when the bundle is refused,
//   REFUSED <code> <detail>\n
//
// Only tests and solutions leave the box: nothing else is needed to judge or validate, and less
// output is less to trust. Paths are already restricted by the validator (no spaces, no newlines).

const EXPORTED = /^(tests|solutions)\//;

export function encodeOpened(result: BundleResult<OpenedBundle>): Uint8Array {
    const parts: Uint8Array[] = [];
    const text = (line: string) => parts.push(new TextEncoder().encode(line));
    if (!result.ok) {
        const detail = result.error.detail.replace(/[\r\n]/g, " ");
        text(`REFUSED ${result.error.code} ${detail}\n`);
        return Buffer.concat(parts);
    }
    text("AURA-OPEN 1\n");
    let count = 0;
    for (const [path, data] of result.value.contents) {
        if (!EXPORTED.test(path)) continue;
        const digest = createHash("sha256").update(data).digest("hex");
        text(`${data.length} ${digest} ${path}\n`);
        parts.push(data);
        text("\n");
        count++;
    }
    text(`END ${count}\n`);
    return Buffer.concat(parts);
}

export function openAndEncode(packed: Uint8Array): Uint8Array {
    return encodeOpened(openBundle(packed));
}
