import { zstdCompressSync } from "node:zlib";
import type { BundleResult } from "./errors.ts";
import { fail, succeed } from "./errors.ts";
import { buildTar, type TarFile } from "./tar-writer.ts";
import { openBundle, validateBundle } from "./validate.ts";
import { type Carriers, embedWatermark } from "./watermark.ts";

// Rebuilds a validated bundle with a delivery's tag written into its carriers (Stage 4C, ADR 0030).
// It runs only where untrusted archives may be parsed: inside a box on a judge node. The result is the
// same canonical form the validator accepts, and it is checked by the validator again before it is
// returned, so a bug here cannot produce a bundle the platform would refuse or that differs from the
// original anywhere but the carriers.

export interface Rewritten {
    readonly packed: Uint8Array;
    readonly carriers: Carriers;
}

// Level and parameters are explicit so the output does not depend on library defaults; the same input
// and tag always give the same bytes.
const compress = (tar: Uint8Array) => new Uint8Array(zstdCompressSync(tar, { params: { 100: 3 } }));

export function rewriteBundle(packed: Uint8Array, tag: number): BundleResult<Rewritten> {
    const opened = openBundle(packed);
    if (!opened.ok) return opened;
    const { bundle, contents } = opened.value;
    // Every file of the bundle is carried over: the opener exports only part of it, the rewriter all.
    const embedded = embedWatermark(contents, tag, bundle.spec.checker.type);
    const files: TarFile[] = [...embedded.files].map(([path, data]) => ({ path, data }));
    const rebuilt = compress(buildTar(files));
    const checked = validateBundle(rebuilt);
    if (!checked.ok)
        return fail(checked.error.code, `the rewritten bundle is refused: ${checked.error.detail}`);
    if (checked.value.files.length !== bundle.files.length) {
        return fail("unexpected_file", "the rewritten bundle has a different set of files");
    }
    return succeed({ packed: rebuilt, carriers: embedded.carriers });
}

// The program a box runs (rewrite-cli.ts): standard input is one header line and then the packed
// bundle, standard output one header line and then the packed result.
//
//   in:  AURA-REWRITE 1 <tag as decimal>\n<packed bundle bytes>
//   out: AURA-REWRITTEN <answers 0|1> <solutions 0|1>\n<packed bundle bytes>
//    or  REFUSED <code> <detail>\n
const REQUEST = /^AURA-REWRITE 1 ([0-9]{1,10})\n/;

export function runRewrite(input: Uint8Array): Uint8Array {
    const newline = input.indexOf(10);
    const head = newline < 0 ? "" : new TextDecoder().decode(input.subarray(0, newline + 1));
    const match = REQUEST.exec(head);
    const refuse = (code: string, detail: string) =>
        new TextEncoder().encode(`REFUSED ${code} ${detail.replace(/[\r\n]/g, " ")}\n`);
    if (match === null) return refuse("invalid_spec", "malformed rewrite request");
    const tag = Number(match[1]);
    let result: BundleResult<Rewritten>;
    try {
        result = rewriteBundle(input.subarray(newline + 1), tag);
    } catch (error) {
        // A tag out of range is the caller's mistake; say so without any bundle content.
        return refuse("invalid_spec", error instanceof Error ? error.message : "rewrite failed");
    }
    if (!result.ok) return refuse(result.error.code, result.error.detail);
    const header = new TextEncoder().encode(
        `AURA-REWRITTEN ${result.value.carriers.answers ? 1 : 0} ${result.value.carriers.solutions ? 1 : 0}\n`,
    );
    const out = new Uint8Array(header.length + result.value.packed.length);
    out.set(header, 0);
    out.set(result.value.packed, header.length);
    return out;
}
