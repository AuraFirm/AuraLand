// Goal: the watermark writes a 32-bit tag into carriers that cannot change a verdict, and reads it back
// from a whole bundle, a partial one and one with files dropped; it leaves everything else alone.
// Method: build bundles of known shape, embed, check what changed, decode.
import { describe, expect, it } from "vitest";
import {
    ANSWER_LINES_MIN,
    carriersOf,
    compareTag,
    decodeWatermark,
    embedWatermark,
    type Files,
    TAG_BITS,
    TAG_MARKER,
} from "./watermark.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const text = (files: Files, path: string) => dec.decode(files.get(path));

// A task with `tests` tests of `lines` answer lines each, a tokens checker and two solutions.
function bundle(tests: number, lines: number): Map<string, Uint8Array> {
    const files = new Map<string, Uint8Array>();
    for (let t = 1; t <= tests; t++) {
        const id = String(t).padStart(3, "0");
        files.set(`tests/${id}.in`, enc.encode(`${t}\n`));
        files.set(
            `tests/${id}.ans`,
            enc.encode(
                Array.from({ length: lines }, (_, i) => `${t * 1000 + i}`).join("\n") + "\n",
            ),
        );
    }
    files.set("solutions/reference.cpp", enc.encode("int main(){}\n"));
    files.set("solutions/wrong_a.py", enc.encode("print(0)\n"));
    files.set("task.json", enc.encode("{}"));
    return files;
}
const TAG = 0xc0ffee42; // top bit set, as every tag is
const tokens = (s: string) => s.split(/\s+/).filter((x) => x !== "");

describe("embedWatermark", () => {
    it("round-trips a whole bundle through both carriers", () => {
        const { files, carriers } = embedWatermark(bundle(4, 20), TAG, "tokens");
        expect(carriers).toEqual({ answers: true, solutions: true });
        const decoded = decodeWatermark(files);
        expect(decoded.answerTag).toBe(TAG);
        expect(decoded.solutionTags).toEqual([TAG, TAG]);
    });

    it("changes nothing a token checker can see, and nothing outside the carriers", () => {
        const original = bundle(4, 20);
        const { files } = embedWatermark(original, TAG, "tokens");
        for (const [path, bytes] of original) {
            if (path.endsWith(".ans")) {
                expect(tokens(text(files, path))).toEqual(tokens(dec.decode(bytes)));
            } else if (!path.startsWith("solutions/")) {
                expect(files.get(path)).toBe(bytes); // the very same bytes
            }
        }
        expect(text(files, "solutions/reference.cpp")).toBe("int main(){}\n// aura-wm:c0ffee42\n");
        expect(text(files, "solutions/wrong_a.py")).toBe("print(0)\n# aura-wm:c0ffee42\n");
    });

    it("is deterministic and differs between tags", () => {
        const a = embedWatermark(bundle(4, 20), TAG, "tokens").files;
        const again = embedWatermark(bundle(4, 20), TAG, "tokens").files;
        const other = embedWatermark(bundle(4, 20), (TAG ^ 1) >>> 0, "tokens").files;
        expect(text(a, "tests/001.ans")).toBe(text(again, "tests/001.ans"));
        const differs = [...a.keys()].some((path) => text(a, path) !== text(other, path));
        expect(differs).toBe(true);
    });

    it("marks only what is safe: no answers for exact checkers or small bundles", () => {
        expect(carriersOf(bundle(4, 20), "exact").answers).toBe(false);
        expect(carriersOf(bundle(1, ANSWER_LINES_MIN - 1), "tokens").answers).toBe(false);
        expect(carriersOf(bundle(1, ANSWER_LINES_MIN), "float").answers).toBe(true);
        const exact = embedWatermark(bundle(4, 20), TAG, "exact").files;
        expect(exact.get("tests/001.ans")).toBe(
            bundle(4, 20).get("tests/001.ans") ? exact.get("tests/001.ans") : undefined,
        );
        expect(text(exact, "tests/001.ans")).toBe(text(bundle(4, 20), "tests/001.ans"));
        expect(decodeWatermark(exact).answerTag).toBeNull();
        expect(decodeWatermark(exact).solutionTags).toEqual([TAG, TAG]);
    });

    it("handles Windows line endings, blank lines, trailing spaces and a missing final newline", () => {
        const files = bundle(0, 0);
        const lines = Array.from({ length: 80 }, (_, i) => (i % 9 === 0 ? "" : `${i}   `)).join(
            "\r\n",
        );
        files.set("tests/001.ans", enc.encode(lines));
        const { files: marked } = embedWatermark(files, TAG, "tokens");
        expect(tokens(text(marked, "tests/001.ans"))).toEqual(tokens(lines));
        expect(text(marked, "tests/001.ans")).not.toMatch(/ {2}\r?\n/); // spaces never pile up
        expect(decodeWatermark(marked).answerTag).toBe(TAG);
    });
});

describe("embedWatermark, repeated and unreadable input", () => {
    it("is idempotent for solutions and leaves unreadable answers alone", () => {
        const once = embedWatermark(bundle(4, 20), TAG, "tokens").files;
        const twice = embedWatermark(once, 0x92345678, "tokens").files;
        expect(decodeWatermark(twice).solutionTags).toEqual([0x92345678, 0x92345678]);
        expect(text(twice, "solutions/reference.cpp").match(/aura-wm/g)?.length).toBe(1);
        const broken = bundle(4, 20);
        broken.set("tests/001.ans", Uint8Array.from([0xff, 0xfe, 0x0a]));
        expect(carriersOf(broken, "tokens").answers).toBe(false);
    });

    it("refuses a tag that is not a 32-bit unsigned integer", () => {
        for (const bad of [-1, 2 ** 32, 1.5, Number.NaN, 0, 0x7fffffff]) {
            expect(() => embedWatermark(bundle(1, 1), bad, "tokens")).toThrow(/32-bit/);
        }
    });
});

describe("decodeWatermark on partial leaks", () => {
    const marked = embedWatermark(bundle(6, 40), TAG, "tokens").files;
    const only = (keep: (path: string) => boolean) =>
        new Map([...marked].filter(([path]) => keep(path)));

    it("decodes from a single large answer file", () => {
        const decoded = decodeWatermark(only((p) => p === "tests/003.ans"));
        expect(decoded.answerTag).toBe(TAG);
    });

    it("decodes from the solutions alone when the answers are gone", () => {
        const decoded = decodeWatermark(only((p) => p.startsWith("solutions/")));
        expect(decoded.answerTag).toBeNull();
        expect(decoded.solutionTags).toEqual([TAG, TAG]);
    });

    it("knows only some bits from a short file and still compares against candidates", () => {
        const small = embedWatermark(bundle(1, 10), TAG, "tokens"); // too few lines: no answer carrier
        expect(small.carriers.answers).toBe(false);
        const few = new Map(
            [...embedWatermark(bundle(2, 40), TAG, "tokens").files].filter(
                ([p]) => p === "tests/001.ans",
            ),
        );
        const trimmed = new Map([
            [
                "tests/001.ans",
                enc.encode(text(few, "tests/001.ans").split("\n").slice(0, 10).join("\n")),
            ],
        ]);
        const decoded = decodeWatermark(trimmed);
        expect(decoded.answerTag).toBeNull();
        const same = compareTag(decoded, TAG);
        expect(same.known).toBe(10);
        expect(same.wrong).toBe(0);
        expect(compareTag(decoded, ~TAG >>> 0).wrong).toBe(10);
    });

    it("finds nothing in an unmarked bundle", () => {
        const decoded = decodeWatermark(bundle(6, 40));
        expect(decoded.solutionTags).toEqual([]);
        expect(decoded.answerTag).toBeNull(); // all-zero bits have no marker bit, so they are no mark
        expect(TAG_BITS).toBe(32);
    });
});

// A seeded sweep: random shapes of answer files and random tags always round-trip, never change the
// tokens a checker sees, and never mark a bundle that does not qualify.
describe("embedWatermark, property sweep", () => {
    it("holds for 200 random bundles", () => {
        let state = 12345;
        const next = (n: number) => {
            state = (Math.imul(state, 1103515245) + 12345) >>> 0;
            return state % n;
        };
        for (let round = 0; round < 200; round++) {
            const files = new Map<string, Uint8Array>();
            const tests = 1 + next(5);
            for (let t = 0; t < tests; t++) {
                const lines = Array.from(
                    { length: next(60) },
                    () => `${next(1000)}${" ".repeat(next(3))}${next(3) === 0 ? " 7.5" : ""}`,
                );
                files.set(`tests/${t}x.ans`, enc.encode(lines.join(next(2) === 0 ? "\n" : "\r\n")));
            }
            const tag = (TAG_MARKER + next(2 ** 31)) >>> 0;
            const { files: marked, carriers } = embedWatermark(files, tag, "tokens");
            for (const [path, bytes] of files) {
                expect(tokens(text(marked, path))).toEqual(tokens(dec.decode(bytes)));
            }
            const decoded = decodeWatermark(marked);
            if (carriers.answers) {
                const comparison = compareTag(decoded, tag);
                expect(comparison.wrong).toBe(0);
            } else {
                expect(decoded.answerTag).toBeNull();
            }
        }
    });
});
