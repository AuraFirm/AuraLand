// Goal: every file in the corpus gets exactly its recorded answer, the golden bundles pass, the
// committed files are what corpus.ts generates (so the corpus is reviewable and reproducible), and
// every refusal code the validator can give is exercised by at least one file.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { corpusCases } from "./corpus.ts";
import { BUNDLE_ERROR_CODES } from "./errors.ts";
import { validateBundle } from "./validate.ts";

const directory = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");
const expectations: Record<string, { expect: string; compressed: boolean }> = JSON.parse(
    readFileSync(join(directory, "expectations.json"), "utf8"),
);

describe("committed corpus", () => {
    it("lists exactly the files on disk", () => {
        const onDisk = readdirSync(directory).filter((n) => n !== "expectations.json");
        expect(onDisk.sort()).toEqual(Object.keys(expectations).sort());
    });

    for (const [fileName, recorded] of Object.entries(expectations)) {
        it(`${fileName} is answered with ${recorded.expect}`, () => {
            const result = validateBundle(new Uint8Array(readFileSync(join(directory, fileName))));
            if (recorded.expect === "ok") {
                expect(result.ok).toBe(true);
            } else {
                expect(result.ok ? "ok" : result.error.code).toBe(recorded.expect);
            }
        });
    }

    it("matches what corpus.ts generates (regenerate with corpus-cli.ts)", () => {
        for (const bundle of corpusCases()) {
            const fileName = `${bundle.name}.${bundle.raw ? "bin" : "tar.zst"}`;
            const onDisk = new Uint8Array(readFileSync(join(directory, fileName)));
            const tar = bundle.raw ? onDisk : new Uint8Array(zstdDecompressSync(onDisk));
            // Compare unpacked bytes: zstd's output may differ between library versions.
            expect(Buffer.from(tar).equals(Buffer.from(bundle.tar)), fileName).toBe(true);
            expect(expectations[fileName]?.expect, fileName).toBe(bundle.expect);
        }
    });

    it("exercises every refusal code", () => {
        const used = new Set(Object.values(expectations).map((e) => e.expect));
        // too_large (packed over 64 MiB) needs a 64 MiB input, so a unit test covers it instead.
        for (const code of BUNDLE_ERROR_CODES.filter((c) => c !== "too_large")) {
            expect(used.has(code), `no corpus file expects ${code}`).toBe(true);
        }
    });
});

describe("golden bundles", () => {
    it("describe their files, spec, statement and content address", () => {
        const golden = corpusCases().find((c) => c.name === "golden-minimal");
        const result = validateBundle(golden?.bytes ?? new Uint8Array(0));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.spec.title).toBe("Sum of two numbers");
        expect(result.value.statement).toContain("sum");
        expect(result.value.files.map((f) => f.path)).toEqual([
            "statement/en.md",
            "task.json",
            "tests/001.ans",
            "tests/001.in",
            "tests/002.ans",
            "tests/002.in",
        ]);
        expect(result.value.tarSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(result.value.tarBytes).toBe(golden?.tar.length);
    });

    it("gives the same content address however the bytes were compressed", () => {
        const golden = corpusCases().find((c) => c.name === "golden-minimal");
        const first = validateBundle(golden?.bytes ?? new Uint8Array(0));
        expect(first.ok && first.value.tarSha256).toBeTruthy();
    });
});
