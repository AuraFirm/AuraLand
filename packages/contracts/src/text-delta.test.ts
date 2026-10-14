// Goal: a chain of deltas rebuilds every text exactly, byte for byte, whatever the text. Method: worked edits, then
// thousands of random edit chains over an alphabet that includes line endings, tabs, combining marks and
// astral characters (surrogate pairs), checking each step and the bytes of the last.

import { describe, expect, it } from "vitest";
import { applyDelta, diffText } from "./text-delta.ts";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const ALPHABET = ["a", "b", " ", "\n", "\r\n", "\t", "é", "é", "\u{1F600}", "\u{1F601}", "}", " "];

// A chain of up to 12 edited texts, each a small random replacement of the one before.
function randomChain(next: (n: number) => number): string[] {
    let text = "";
    const snapshots: string[] = [];
    for (let i = 0; i < 1 + next(12); i++) {
        const at = next(text.length + 1);
        const cut = next(4);
        const add = Array.from({ length: next(4) }, () => ALPHABET[next(ALPHABET.length)]).join("");
        text = text.slice(0, at) + add + text.slice(at + cut);
        // A cut might land inside a pair: keep every text well-formed.
        text = text.replace(LONE_SURROGATE, "\uFFFD");
        snapshots.push(text);
    }
    return snapshots;
}

describe("diffText and applyDelta", () => {
    it("keeps the common prefix and suffix and replaces the middle", () => {
        expect(diffText("int main() {}", "int main() { return 0; }")).toEqual({
            start: 12,
            remove: 0,
            insert: " return 0; ",
        });
        expect(diffText("abc", "abc")).toEqual({ start: 3, remove: 0, insert: "" });
        expect(diffText("", "new")).toEqual({ start: 0, remove: 0, insert: "new" });
        expect(diffText("old", "")).toEqual({ start: 0, remove: 3, insert: "" });
    });

    it("never splits a surrogate pair", () => {
        const before = "a\u{1F600}b"; // 😀
        const after = "a\u{1F601}b"; // 😁: the two share their high surrogate
        const delta = diffText(before, after);
        expect(delta.start).toBe(1);
        expect(delta.remove).toBe(2);
        expect(applyDelta(before, delta)).toBe(after);
    });

    it("refuses a change outside the text", () => {
        expect(() => applyDelta("abc", { start: 2, remove: 5, insert: "" })).toThrow();
        expect(() => applyDelta("abc", { start: -1, remove: 0, insert: "" })).toThrow();
    });

    it("rebuilds every snapshot of 3,000 random edit chains exactly, bytes included", () => {
        let state = 7;
        const next = (n: number) => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state % n;
        };
        for (let chain = 0; chain < 3000; chain++) {
            const snapshots = randomChain(next);
            let rebuilt = "";
            let previous = "";
            for (const snapshot of snapshots) {
                rebuilt = applyDelta(rebuilt, diffText(previous, snapshot));
                expect(rebuilt).toBe(snapshot);
                previous = snapshot;
            }
            expect(Buffer.from(rebuilt, "utf8").equals(Buffer.from(previous, "utf8"))).toBe(true);
        }
    });
});
