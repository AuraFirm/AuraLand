import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { assert } from "@aura/contracts/assert";
import {
    BUNDLE_BYTES_MAX,
    BUNDLE_COMPRESSION_RATIO_MAX,
    BUNDLE_ENTRIES_MAX,
    BUNDLE_RATIO_FLOOR_BYTES,
    BUNDLE_TEST_FILE_BYTES_MAX,
    BUNDLE_UNCOMPRESSED_BYTES_MAX,
    SPEC_FILE_BYTES_MAX,
    STATEMENT_BYTES_MAX,
} from "@aura/contracts/limits";
import { type TaskSpec, taskSpecSchema } from "@aura/contracts/tasks";
import { type BundleResult, fail, succeed } from "./errors.ts";
import { readTar, type TarEntry } from "./tar.ts";

// The bundle ingest validator (docs/kit/07 section 7): bytes in, either a verified description of
// the bundle or one specific refusal out. It is a pure function of its input: no files, no network,
// no clock. It must run only where untrusted archives may be parsed (the sandbox, from Stage 3) and
// in tests; the API host checks size and hash of the uploaded bytes and never calls this.

export interface ValidatedFile {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
}

export interface ValidatedBundle {
    readonly spec: TaskSpec;
    readonly statement: string;
    readonly files: readonly ValidatedFile[];
    // SHA-256 of the unpacked canonical tar: the content address the kit defines (docs/kit/07).
    readonly tarSha256: string;
    readonly tarBytes: number;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Null instead of an exception when the bytes are not UTF-8. A byte-order mark is kept as text, so
// it fails JSON parsing instead of being silently dropped.
function decodeUtf8(bytes: Uint8Array): string | null {
    try {
        return utf8.decode(bytes);
    } catch {
        return null;
    }
}

function unpack(packed: Uint8Array): BundleResult<Uint8Array> {
    if (packed.length === 0) return fail("empty", "no bytes");
    if (packed.length > BUNDLE_BYTES_MAX) return fail("too_large", "packed size over the cap");
    const ratioLimit = Math.max(
        packed.length * BUNDLE_COMPRESSION_RATIO_MAX,
        BUNDLE_RATIO_FLOOR_BYTES,
    );
    const outputMax = Math.min(ratioLimit, BUNDLE_UNCOMPRESSED_BYTES_MAX);
    try {
        const tar = zstdDecompressSync(packed, { maxOutputLength: outputMax });
        return succeed(new Uint8Array(tar.buffer, tar.byteOffset, tar.length));
    } catch (error) {
        // The library signals "more output than allowed" with this code; anything else is bad input.
        const code = error instanceof Error && "code" in error ? error.code : "";
        if (code !== "ERR_BUFFER_TOO_LARGE") return fail("bad_compression", "not valid zstd data");
        return outputMax < BUNDLE_UNCOMPRESSED_BYTES_MAX
            ? fail("compression_ratio", `unpacks to more than ${BUNDLE_COMPRESSION_RATIO_MAX}x`)
            : fail("too_large", "unpacked size over the cap");
    }
}

const TEST_FILE = /^tests\/([A-Za-z0-9][A-Za-z0-9_.-]*)\.(in|ans)$/;
// Parts of the layout that are optional and free-form below their directory (docs/kit/07 section 7).
// statement/assets and env/ are not accepted yet: images and Tier-2 environments arrive later.
const FREE_FORM = /^(samples|solutions|generators|validator)\/[^/]+$/;
const STATEMENT_FILE = /^statement\/[a-z]{2}\.md$/;
const CHECKER_FILE = /^checker\/(checker\.cpp|checker\.py)$/;

function checkLayout(files: ReadonlyMap<string, Uint8Array>, spec: TaskSpec): BundleResult<null> {
    const wanted = new Set<string>();
    for (const test of spec.tests) {
        for (const extension of ["in", "ans"]) wanted.add(`tests/${test.id}.${extension}`);
    }
    for (const path of wanted) {
        if (!files.has(path)) return fail("missing_file", path);
    }
    const customChecker = spec.checker.type === "custom";
    let checkerFiles = 0;
    for (const path of files.keys()) {
        if (TEST_FILE.test(path)) {
            if (!wanted.has(path)) return fail("unexpected_file", `${path} is not in the spec`);
        } else if (CHECKER_FILE.test(path)) {
            checkerFiles++;
            if (!customChecker)
                return fail("unexpected_file", `${path} but the checker is built in`);
        } else if (path !== "task.json" && !STATEMENT_FILE.test(path) && !FREE_FORM.test(path)) {
            return fail("unexpected_file", path);
        }
    }
    if (customChecker && checkerFiles !== 1) return fail("missing_file", "checker/checker.cpp|py");
    return succeed(null);
}

function readSpec(task: Uint8Array | undefined): BundleResult<TaskSpec> {
    if (task === undefined) return fail("missing_file", "task.json");
    if (task.length > SPEC_FILE_BYTES_MAX) return fail("bad_spec_json", "task.json is too large");
    const source = decodeUtf8(task);
    if (source === null) return fail("bad_spec_json", "task.json is not UTF-8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(source);
    } catch {
        return fail("bad_spec_json", "task.json is not JSON");
    }
    const result = taskSpecSchema.safeParse(parsed);
    if (!result.success) {
        const issue = result.error.issues[0];
        return fail("invalid_spec", `${issue?.path.join(".") ?? ""}: ${issue?.message ?? ""}`);
    }
    return succeed(result.data);
}

function readStatement(bytes: Uint8Array | undefined): BundleResult<string> {
    if (bytes === undefined) return fail("missing_file", "statement/en.md");
    if (bytes.length === 0 || bytes.length > STATEMENT_BYTES_MAX) {
        return fail("bad_statement", "statement is empty or too large");
    }
    const statement = decodeUtf8(bytes);
    return statement === null
        ? fail("bad_statement", "statement is not UTF-8")
        : succeed(statement);
}

function describe(entries: readonly TarEntry[]): ValidatedFile[] {
    return entries.map((entry) => ({
        path: entry.path,
        bytes: entry.data.length,
        sha256: sha256(entry.data),
    }));
}

export function validateBundle(packed: Uint8Array): BundleResult<ValidatedBundle> {
    const tar = unpack(packed);
    if (!tar.ok) return tar;
    const read = readTar(tar.value, {
        entriesMax: BUNDLE_ENTRIES_MAX,
        fileBytesMax: BUNDLE_TEST_FILE_BYTES_MAX,
    });
    if (!read.ok) return read;
    const files = new Map(read.value.map((entry) => [entry.path, entry.data]));
    assert(files.size === read.value.length, "the reader already refused duplicate paths");
    const spec = readSpec(files.get("task.json"));
    if (!spec.ok) return spec;
    const statement = readStatement(files.get("statement/en.md"));
    if (!statement.ok) return statement;
    const layout = checkLayout(files, spec.value);
    if (!layout.ok) return layout;
    return succeed({
        spec: spec.value,
        statement: statement.value,
        files: describe(read.value),
        tarSha256: sha256(tar.value),
        tarBytes: tar.value.length,
    });
}
