// Goal: the parts of a file are cut exactly where the API's plan says, with no gap and no overlap.
import { describe, expect, it } from "vitest";
import { partRanges } from "./upload.ts";

describe("partRanges", () => {
    it("lays parts end to end from zero", () => {
        const ranges = partRanges([{ bytes: 8 }, { bytes: 8 }, { bytes: 3 }]);
        expect(ranges).toEqual([
            { start: 0, end: 8 },
            { start: 8, end: 16 },
            { start: 16, end: 19 },
        ]);
    });

    it("handles one part and no parts", () => {
        expect(partRanges([{ bytes: 5 }])).toEqual([{ start: 0, end: 5 }]);
        expect(partRanges([])).toEqual([]);
    });
});
