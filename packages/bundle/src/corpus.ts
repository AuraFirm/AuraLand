import { zstdCompressSync } from "node:zlib";
import { assert } from "@aura/contracts/assert";
import type { BundleErrorCode } from "./errors.ts";
import {
    BLOCK,
    buildTar,
    canonicalFields,
    concat,
    type HeaderFields,
    headerBlock,
    paddedData,
    type TarFile,
    ZERO_BLOCKS,
} from "./tar-writer.ts";

// The malformed-bundle corpus (docs/kit/08 section 5, fuzz targets and corpus first). Every case is a
// complete input for the validator plus the one answer it must give. The cases are generated here,
// written to packages/bundle/corpus/ by corpus-cli.ts, and read back by tests; any implementation of
// the validator (the Go port in Stage 3, if it comes to that) must give the same answers on the same
// files. `expect` is "ok" for golden bundles and a refusal code otherwise.

export interface CorpusCase {
    readonly name: string;
    readonly expect: "ok" | BundleErrorCode;
    // The exact input to the validator. Compressed with zstd unless `raw` is true.
    readonly bytes: Uint8Array;
    readonly raw: boolean;
    // The uncompressed tar, kept so tests can check regeneration independent of zstd's output.
    readonly tar: Uint8Array;
}

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (path: string, text: string | Uint8Array): TarFile => ({
    path,
    data: typeof text === "string" ? enc(text) : text,
});

const SPEC = {
    spec_version: 1,
    kind: "algorithmic",
    title: "Sum of two numbers",
    time_limit_ms: 1000,
    memory_limit_kib: 262144,
    output_limit_kib: 1024,
    languages: ["cpp", "python3"],
    scoring: { type: "binary", subtasks: [] },
    tests: [
        { id: "001", group: "all", points: 50, is_sample: true },
        { id: "002", group: "all", points: 50, is_sample: false },
    ],
    checker: { type: "exact" },
    license: { owner: "Acme", terms: "internal use" },
    provenance: { author: "Alice", created: "2026-10-10", generated_with_ai: false },
};

const specFile = (spec: unknown = SPEC): TarFile => file("task.json", JSON.stringify(spec));

// The smallest valid bundle's files.
export function goldenFiles(): TarFile[] {
    return [
        specFile(),
        file("statement/en.md", "Read two integers and print their sum.\n"),
        file("tests/001.in", "1 2\n"),
        file("tests/001.ans", "3\n"),
        file("tests/002.in", "40 2\n"),
        file("tests/002.ans", "42\n"),
    ];
}

function richFiles(): TarFile[] {
    const spec = {
        ...SPEC,
        checker: { type: "custom" },
        scoring: { type: "subtasks", subtasks: [{ group: "all", points: 100 }] },
    };
    return [
        ...goldenFiles().filter((f) => f.path !== "task.json"),
        specFile(spec),
        file("statement/bn.md", "দুটি সংখ্যার যোগফল।\n"),
        file("checker/checker.py", "print('ok')\n"),
        file("samples/1.in", "1 2\n"),
        file("samples/1.out", "3\n"),
        file("solutions/ref.cpp", "int main(){}\n"),
        file("solutions/wa1.py", "print(0)\n"),
        file("generators/gen.py", "print(1)\n"),
        file("validator/validator.py", "pass\n"),
    ];
}

const withoutFile = (path: string): TarFile[] => goldenFiles().filter((f) => f.path !== path);
const replaced = (path: string, text: string | Uint8Array): TarFile[] => [
    ...withoutFile(path),
    file(path, text),
];

function compress(tar: Uint8Array): Uint8Array {
    // Level and parameters are explicit so the output does not depend on library defaults.
    return new Uint8Array(zstdCompressSync(tar, { params: { 100: 3 } }));
}

function packed(name: string, expect: CorpusCase["expect"], tar: Uint8Array): CorpusCase {
    return { name, expect, bytes: compress(tar), raw: false, tar };
}

function raw(name: string, expect: CorpusCase["expect"], bytes: Uint8Array): CorpusCase {
    return { name, expect, bytes, raw: true, tar: bytes };
}

// One raw tar entry from fields, for cases the canonical writer would never emit.
function entry(fields: HeaderFields, data: Uint8Array = new Uint8Array(0)): Uint8Array {
    return concat([headerBlock(fields), paddedData(data)]);
}

function fieldsFor(path: string, change: Partial<HeaderFields> = {}): HeaderFields {
    return { ...canonicalFields(path, 0), ...change };
}

// A tar whose first entries are the given raw parts, followed by the rest of the golden files.
function tarWith(...parts: Uint8Array[]): Uint8Array {
    return concat([...parts, ZERO_BLOCKS(2)]);
}

// The golden files as a tar, with one entry swapped for a raw replacement.
function goldenWith(path: string, replacement: Uint8Array): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const f of [...goldenFiles()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
        parts.push(
            f.path === path ? replacement : entry(canonicalFields(f.path, f.data.length), f.data),
        );
    }
    return tarWith(...parts);
}

function archiveCases(): CorpusCase[] {
    const golden = buildTar(goldenFiles());
    const zeros = (megabytes: number) => new Uint8Array(megabytes * 1024 * 1024);
    return [
        packed("golden-minimal", "ok", golden),
        packed("golden-rich", "ok", buildTar(richFiles())),
        raw("empty-input", "empty", new Uint8Array(0)),
        raw("not-zstd", "bad_compression", enc("this is not a compressed bundle at all")),
        raw("truncated-zstd", "bad_compression", compress(golden).subarray(0, 20)),
        packed("ratio-bomb-8mib-of-zeros", "compression_ratio", zeros(8)),
        packed("ratio-bomb-300mib-of-zeros", "compression_ratio", zeros(300)),
        packed("tar-empty-file-list", "missing_file", ZERO_BLOCKS(2)),
        packed("tar-ends-inside-header", "truncated", golden.subarray(0, 300)),
        packed("tar-ends-inside-data", "truncated", golden.subarray(0, BLOCK + 3)),
        packed("tar-without-trailer", "truncated", golden.subarray(0, golden.length - 2 * BLOCK)),
        packed("tar-one-trailer-block", "bad_trailer", golden.subarray(0, golden.length - BLOCK)),
        packed("tar-bytes-after-trailer", "bad_trailer", concat([golden, ZERO_BLOCKS(1)])),
        packed("tar-garbage-after-trailer", "bad_trailer", concat([golden, enc("x")])),
    ];
}

const sized = (path: string, change: Partial<HeaderFields>) =>
    entry(fieldsFor(path, change), new Uint8Array(0));

function entryTypeCases(): CorpusCase[] {
    const badChecksum = concat([
        headerBlock(canonicalFields("a.txt", 0), "0000001\0"),
        ZERO_BLOCKS(2),
    ]);
    const wrongChecksum = concat([
        headerBlock(canonicalFields("a.txt", 0), "000001\0 "),
        ZERO_BLOCKS(2),
    ]);
    const typed = (typeflag: string, label: string, name = "a.txt") =>
        packed(`entry-type-${label}`, "unsupported_entry", tarWith(sized(name, { typeflag })));
    return [
        packed("header-bad-checksum", "bad_checksum", badChecksum),
        packed("header-checksum-wrong-value", "bad_checksum", wrongChecksum),
        typed("1", "hard-link"), // hard link
        typed("2", "symbolic-link"), // symbolic link
        typed("3", "character-device"), // character device
        typed("4", "block-device"), // block device
        typed("5", "directory", "dir"), // directory
        typed("6", "fifo"), // fifo
        typed("x", "pax-extended"), // pax extended header
        typed("g", "pax-global"), // pax global header
        typed("L", "gnu-long-name"), // GNU long name
        typed("\0", "old-style-regular"), // old-style regular file
    ];
}

function headerFieldCases(): CorpusCase[] {
    return [
        packed(
            "header-mode-0777",
            "non_canonical_header",
            tarWith(sized("a.txt", { mode: "0000777\0" })),
        ),
        packed(
            "header-setuid-mode",
            "non_canonical_header",
            tarWith(sized("a.txt", { mode: "0004755\0" })),
        ),
    ];
}

function headerOwnerCases(): CorpusCase[] {
    return [
        packed(
            "header-uid-nonzero",
            "non_canonical_header",
            tarWith(sized("a.txt", { uid: "0001750\0" })),
        ),
        packed(
            "header-gid-nonzero",
            "non_canonical_header",
            tarWith(sized("a.txt", { gid: "0001750\0" })),
        ),
        packed(
            "header-mtime-nonzero",
            "non_canonical_header",
            tarWith(sized("a.txt", { mtime: "14000000000\0" })),
        ),
        packed(
            "header-owner-name",
            "non_canonical_header",
            tarWith(sized("a.txt", { uname: "root" })),
        ),
        packed(
            "header-group-name",
            "non_canonical_header",
            tarWith(sized("a.txt", { gname: "wheel" })),
        ),
        packed(
            "header-prefix-used",
            "non_canonical_header",
            tarWith(sized("a.txt", { prefix: "some/dir" })),
        ),
        packed(
            "header-linkname-set",
            "non_canonical_header",
            tarWith(sized("a.txt", { linkname: "target" })),
        ),
        packed(
            "header-bad-magic",
            "non_canonical_header",
            tarWith(sized("a.txt", { magic: "GNUtar" })),
        ),
        packed(
            "header-old-gnu-version",
            "non_canonical_header",
            tarWith(sized("a.txt", { version: " \0" })),
        ),
        packed(
            "header-devmajor-set",
            "non_canonical_header",
            tarWith(sized("a.txt", { devmajor: "0000007\0" })),
        ),
        packed(
            "header-size-not-octal",
            "non_canonical_header",
            tarWith(sized("a.txt", { sizeText: "00000000008\0" })),
        ),
        packed(
            "header-size-base256",
            "non_canonical_header",
            tarWith(sized("a.txt", { sizeText: "\x80\0\0\0\0\0\0\0\0\0\0\x05" })),
        ),
        packed(
            "header-size-unterminated",
            "non_canonical_header",
            tarWith(sized("a.txt", { sizeText: "000000000000" })),
        ),
    ];
}

function pathCases(): CorpusCase[] {
    const at = (name: string, path: string) =>
        packed(name, "unsafe_path", tarWith(entry(fieldsFor(path))));
    return [
        at("path-absolute", "/etc/passwd"),
        at("path-dotdot", "../escape.txt"),
        at("path-dotdot-inside", "tests/../../escape.txt"),
        at("path-single-dot", "./a.txt"),
        at("path-backslash", "tests\\001.in"),
        at("path-empty-segment", "tests//001.in"),
        at("path-trailing-slash", "tests/"),
        at("path-hidden-file", ".hidden"),
        at("path-space", "my file.txt"),
        at("path-non-ascii", "tests/é.in"),
        at("path-control-character", "a\x01b.txt"),
        at("path-too-deep", "a/b/c/d/e.txt"),
        at("path-segment-too-long", `${"a".repeat(65)}.txt`),
        at("path-nul-then-text", "ok.txt\0/../../x"),
        at("path-colon-drive", "C:evil.txt"),
    ];
}

function orderCases(): CorpusCase[] {
    const a = entry(fieldsFor("a.txt"));
    const b = entry(fieldsFor("b.txt"));
    const upperA = entry(fieldsFor("A.txt"));
    const padded = (size: number, change: Uint8Array) => {
        const data = new Uint8Array(size);
        return concat([
            headerBlock(canonicalFields("a.txt", size)),
            paddedData(data).map((_, i) => change[i] ?? 0),
        ]);
    };
    return [
        packed("order-duplicate-exact", "duplicate_path", tarWith(a, a)),
        packed("order-duplicate-letter-case", "duplicate_path", tarWith(upperA, a)),
        packed(
            "order-duplicate-mixed-case",
            "duplicate_path",
            tarWith(entry(fieldsFor("Ab.txt")), entry(fieldsFor("aB.txt"))),
        ),
        packed("order-unsorted", "unsorted_entries", tarWith(b, a)),
        packed(
            "padding-not-zero",
            "bad_padding",
            tarWith(padded(5, Uint8Array.from([1, 2, 3, 4, 5, 9]))),
        ),
        packed(
            "entry-count-over-limit",
            "too_many_entries",
            tarWith(
                ...Array.from({ length: 5001 }, (_, i) =>
                    entry(fieldsFor(`f/${String(i).padStart(5, "0")}.txt`)),
                ),
            ),
        ),
        packed(
            "file-over-size-limit",
            "file_too_large",
            tarWith(entry(fieldsFor("tests/big.in", { sizeText: "00400000001\0" }))),
        ),
    ];
}

function layoutCases(): CorpusCase[] {
    const spec = (change: Record<string, unknown>) =>
        replaced("task.json", JSON.stringify({ ...SPEC, ...change }));
    const cases: [string, CorpusCase["expect"], TarFile[]][] = [
        ["layout-no-task-json", "missing_file", withoutFile("task.json")],
        ["layout-no-statement", "missing_file", withoutFile("statement/en.md")],
        ["layout-test-input-missing", "missing_file", withoutFile("tests/002.in")],
        ["layout-test-answer-missing", "missing_file", withoutFile("tests/002.ans")],
        [
            "layout-extra-test-file",
            "unexpected_file",
            [...goldenFiles(), file("tests/003.in", "x")],
        ],
        ["layout-top-level-file", "unexpected_file", [...goldenFiles(), file("README", "hi")]],
        [
            "layout-statement-asset",
            "unexpected_file",
            [...goldenFiles(), file("statement/assets/a.png", "x")],
        ],
        ["layout-env-directory", "unexpected_file", [...goldenFiles(), file("env/Recipe", "x")]],
        [
            "layout-checker-with-builtin",
            "unexpected_file",
            [...goldenFiles(), file("checker/checker.py", "x")],
        ],
        ["layout-custom-checker-missing", "missing_file", spec({ checker: { type: "custom" } })],
        ["spec-not-json", "bad_spec_json", replaced("task.json", "{ not json")],
        [
            "spec-not-utf8",
            "bad_spec_json",
            replaced("task.json", Uint8Array.from([0x7b, 0xff, 0x7d])),
        ],
        [
            "spec-with-bom",
            "bad_spec_json",
            replaced("task.json", `${String.fromCharCode(0xfeff)}${JSON.stringify(SPEC)}`),
        ],
        [
            "spec-too-large",
            "bad_spec_json",
            replaced("task.json", `{"pad":"${"x".repeat(262144)}"}`),
        ],
        ["spec-array", "invalid_spec", replaced("task.json", "[]")],
        ["spec-unknown-field", "invalid_spec", spec({ extra: 1 })],
        ["spec-unsupported-kind", "invalid_spec", spec({ kind: "sql" })],
        ["spec-wrong-version", "invalid_spec", spec({ spec_version: 2 })],
        ["spec-time-limit-too-high", "invalid_spec", spec({ time_limit_ms: 60000 })],
        ["spec-duplicate-test-id", "invalid_spec", spec({ tests: [SPEC.tests[0], SPEC.tests[0]] })],
        [
            "spec-test-id-with-slash",
            "invalid_spec",
            spec({ tests: [{ ...SPEC.tests[0], id: "a/b" }] }),
        ],
        ["statement-empty", "bad_statement", replaced("statement/en.md", "")],
        [
            "statement-not-utf8",
            "bad_statement",
            replaced("statement/en.md", Uint8Array.from([0xc3, 0x28])),
        ],
        ["statement-too-large", "bad_statement", replaced("statement/en.md", "a".repeat(65537))],
    ];
    return cases.map(([name, expect, files]) => packed(name, expect, buildTar(files)));
}

export function corpusCases(): CorpusCase[] {
    const cases = [
        ...archiveCases(),
        ...entryTypeCases(),
        ...headerFieldCases(),
        ...headerOwnerCases(),
        ...pathCases(),
        ...orderCases(),
        ...layoutCases(),
        packed(
            "tar-golden-with-symlink-first",
            "unsupported_entry",
            goldenWith(
                "task.json",
                entry(fieldsFor("task.json", { typeflag: "2", linkname: "/etc/passwd" })),
            ),
        ),
    ];
    const names = new Set(cases.map((c) => c.name));
    assert(names.size === cases.length, "corpus case names must be unique");
    return cases;
}
