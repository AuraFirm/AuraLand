// Goal: the validator never throws whatever the bytes, refuses oversized packed input, and
// reports refusals as a closed set of codes. The corpus pins specific answers; this file pins the
// properties and the one limit the corpus cannot hold in a file (64 MiB packed).
import { randomBytes } from "node:crypto";
import { BUNDLE_BYTES_MAX } from "@aura/contracts/limits";
import { describe, expect, it } from "vitest";
import { BUNDLE_ERROR_CODES } from "./errors.ts";
import { fuzzValidator } from "./fuzz.ts";
import { isSafeEntryPath } from "./paths.ts";
import { validateBundle } from "./validate.ts";

describe("validateBundle", () => {
    it("refuses a packed input over the cap without reading it", () => {
        const result = validateBundle(new Uint8Array(BUNDLE_BYTES_MAX + 1));
        expect(result.ok ? "ok" : result.error.code).toBe("too_large");
    });

    it("answers random bytes of many lengths with a known code, never an exception", () => {
        for (const length of [1, 2, 3, 4, 5, 8, 31, 511, 512, 513, 1024, 5000]) {
            for (let attempt = 0; attempt < 20; attempt++) {
                const result = validateBundle(new Uint8Array(randomBytes(length)));
                expect(result.ok).toBe(false);
                if (!result.ok) expect(BUNDLE_ERROR_CODES).toContain(result.error.code);
            }
        }
    });

    it("survives 3000 mutations of corpus bundles", () => {
        const report = fuzzValidator(7, 3000);
        expect(report.iterations).toBe(3000);
        // Mutations should mostly be caught, and several different codes should appear.
        expect(Object.keys(report.codes).length).toBeGreaterThan(5);
    });

    it("never gives details that quote the bundle's contents", () => {
        const hostile = `{"title":"SECRET-MARKER-${"x".repeat(10)}"`;
        const result = validateBundle(new TextEncoder().encode(hostile));
        expect(JSON.stringify(result)).not.toContain("SECRET-MARKER");
    });
});

describe("isSafeEntryPath", () => {
    it("accepts the layout's paths and refuses every escape", () => {
        for (const ok of ["task.json", "statement/en.md", "tests/001.in", "a/b/c/d"]) {
            expect(isSafeEntryPath(ok), ok).toBe(true);
        }
        const bad = [
            "",
            "/",
            "/a",
            "a/",
            "a//b",
            "../a",
            "a/../b",
            ".",
            "..",
            ".a",
            "a/.b",
            "a b",
            "a\\b",
            "a\0b",
            "é",
            "a/b/c/d/e",
        ];
        for (const path of bad) expect(isSafeEntryPath(path), JSON.stringify(path)).toBe(false);
        expect(isSafeEntryPath("a".repeat(64))).toBe(true);
        expect(isSafeEntryPath("a".repeat(65))).toBe(false);
    });
});
