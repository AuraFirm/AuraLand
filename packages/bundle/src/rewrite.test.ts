// Goal: rewriting puts the tag into a delivery's bundle and changes nothing else; the result is a
// bundle the validator accepts, deterministic, and decodes back to the tag. Method: rewrite corpus and
// hand-built bundles, compare file by file.
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { corpusCases } from "./corpus.ts";
import { rewriteBundle, runRewrite } from "./rewrite.ts";
import { buildTar } from "./tar-writer.ts";
import { openBundle, validateBundle } from "./validate.ts";
import { decodeWatermark } from "./watermark.ts";

const TAG = 0xc0ffee42;
const enc = new TextEncoder();
const dec = new TextDecoder();
const golden = (name: string) => {
    const found = corpusCases().find((c) => c.name === name);
    if (found === undefined) throw new Error(`no corpus case ${name}`);
    return found.bytes;
};
function contents(packed: Uint8Array) {
    const opened = openBundle(packed);
    if (!opened.ok) throw new Error(opened.error.code);
    return opened.value.contents;
}

// A task with a tokens checker and enough answer lines to carry the answer mark.
function tokensBundle(): Uint8Array {
    const spec = {
        spec_version: 1,
        kind: "algorithmic",
        title: "Numbers",
        time_limit_ms: 1000,
        memory_limit_kib: 262144,
        output_limit_kib: 1024,
        languages: ["cpp"],
        scoring: { type: "binary", subtasks: [] },
        tests: [1, 2, 3].map((n) => ({
            id: `00${n}`,
            group: "all",
            points: 10,
            is_sample: n === 1,
        })),
        checker: { type: "tokens" },
        license: { owner: "Acme", terms: "internal use" },
        provenance: { author: "Alice", created: "2026-10-10", generated_with_ai: false },
    };
    const files = [
        { path: "task.json", data: enc.encode(JSON.stringify(spec)) },
        { path: "statement/en.md", data: enc.encode("Print numbers.\n") },
        { path: "solutions/reference.cpp", data: enc.encode("int main(){}\n") },
    ];
    for (const id of ["001", "002", "003"]) {
        files.push({ path: `tests/${id}.in`, data: enc.encode("1\n") });
        files.push({
            path: `tests/${id}.ans`,
            data: enc.encode(`${Array.from({ length: 30 }, (_, i) => i).join("\n")}\n`),
        });
    }
    return new Uint8Array(zstdCompressSync(buildTar(files), { params: { 100: 3 } }));
}

describe("rewriteBundle", () => {
    it("writes the tag into the solutions of a bundle that has no safe answers, and nothing else", () => {
        const original = golden("golden-solved");
        const result = rewriteBundle(original, TAG);
        if (!result.ok) throw new Error(result.error.code);
        expect(result.value.carriers).toEqual({ answers: false, solutions: true });
        expect(validateBundle(result.value.packed).ok).toBe(true);
        const before = contents(original);
        const after = contents(result.value.packed);
        expect([...after.keys()]).toEqual([...before.keys()]);
        for (const [path, bytes] of before) {
            const same = dec.decode(after.get(path)) === dec.decode(bytes);
            expect(same).toBe(!path.startsWith("solutions/"));
        }
        expect(decodeWatermark(after).solutionTags.length).toBe(5);
    });

    it("also marks the answers of a tokens task, with unchanged tokens, and decodes back", () => {
        const result = rewriteBundle(tokensBundle(), TAG);
        if (!result.ok) throw new Error(result.error.code);
        expect(result.value.carriers).toEqual({ answers: true, solutions: true });
        const after = contents(result.value.packed);
        expect(decodeWatermark(after).answerTag).toBe(TAG);
        const before = contents(tokensBundle());
        for (const path of ["tests/001.ans", "tests/003.ans"]) {
            const tokens = (b: Uint8Array | undefined) =>
                dec.decode(b).split(/\s+/).filter(Boolean);
            expect(tokens(after.get(path))).toEqual(tokens(before.get(path)));
        }
        expect(dec.decode(after.get("tests/001.in"))).toBe("1\n");
    });

    it("is deterministic, and different tags give different bytes", () => {
        const a = rewriteBundle(tokensBundle(), TAG);
        const b = rewriteBundle(tokensBundle(), TAG);
        const c = rewriteBundle(tokensBundle(), (TAG ^ 4) >>> 0);
        if (!a.ok || !b.ok || !c.ok) throw new Error("rewrite failed");
        expect(Buffer.compare(a.value.packed, b.value.packed)).toBe(0);
        expect(Buffer.compare(a.value.packed, c.value.packed)).not.toBe(0);
    });

    it("refuses what the validator refuses, with its code", () => {
        for (const [name, code] of [
            ["layout-no-statement", "missing_file"],
            ["ratio-bomb-300mib-of-zeros", "compression_ratio"],
            ["tar-golden-with-symlink-first", "unsupported_entry"],
        ] as const) {
            const result = rewriteBundle(golden(name), TAG);
            expect(result.ok).toBe(false);
            expect(!result.ok && result.error.code).toBe(code);
        }
    });
});

describe("runRewrite", () => {
    const request = (tag: string, bundle: Uint8Array) => {
        const head = enc.encode(`AURA-REWRITE 1 ${tag}\n`);
        const input = new Uint8Array(head.length + bundle.length);
        input.set(head, 0);
        input.set(bundle, head.length);
        return runRewrite(input);
    };

    it("answers with a header line and the packed result", () => {
        const out = request(String(TAG), tokensBundle());
        const newline = out.indexOf(10);
        expect(dec.decode(out.subarray(0, newline + 1))).toBe("AURA-REWRITTEN 1 1\n");
        expect(validateBundle(out.subarray(newline + 1)).ok).toBe(true);
    });

    it("refuses a malformed request, a tag out of range and a bad bundle in one line", () => {
        for (const out of [
            runRewrite(enc.encode("nonsense")),
            request("123", tokensBundle()), // top bit not set
            request(String(TAG), new Uint8Array([1, 2, 3])),
        ]) {
            const text = dec.decode(out);
            expect(text.startsWith("REFUSED ")).toBe(true);
            expect(text.split("\n").length).toBe(2);
        }
    });
});
