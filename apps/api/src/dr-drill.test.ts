// Goal: the drill's comparison names every kind of damage a restore can do, and says nothing when the restore is exact.
import { describe, expect, it } from "vitest";
import { compareCounts } from "./dr-drill.ts";

describe("compareCounts", () => {
    it("finds nothing when both sides agree", () => {
        expect(compareCounts({ a: 1, b: 0 }, { b: 0, a: 1 })).toEqual([]);
    });
    it("names a missing table, a changed count and an extra table", () => {
        expect(compareCounts({ a: 3, b: 1, c: 2 }, { a: 2, c: 2, d: 9 })).toEqual([
            "a: 3 rows before, 2 after",
            "b: missing after restore",
            "d: appeared only in the restore",
        ]);
    });
    it("treats an empty table that came back as fine and one that did not as missing", () => {
        expect(compareCounts({ a: 0 }, { a: 0 })).toEqual([]);
        expect(compareCounts({ a: 0 }, {})).toEqual(["a: missing after restore"]);
    });
});
