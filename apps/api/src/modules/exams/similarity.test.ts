// Goal: winnowing finds copying that survives cosmetic edits and does not invent it between different programs.
// Method: worked cases (renaming, literals, comments, reordering, unrelated code, empty and tiny sources) and a
// seeded corpus where known copies are planted among unrelated programs and must be the top pairs.

import { describe, expect, it } from "vitest";
import { compare, fingerprints, prepare, similarPairs, tokenize } from "./similarity.ts";

const ORIGINAL = `#include <stdio.h>
int main() {
    int total = 0;
    for (int i = 0; i < 10; i++) {
        if (i % 2 == 0) total += i * 3;
        else total -= 1;
    }
    printf("%d\\n", total);
    return 0;
}`;
const RENAMED = `#include <stdio.h>
// a different comment
int main() {
    int sum = 0;   /* changed */
    for (int k = 0; k < 99; k++) {
        if (k % 7 == 1) sum += k * 12;
        else sum -= 5;
    }
    printf("answer %d\\n", sum);
    return 0;
}`;
const DIFFERENT = `#include <iostream>
#include <vector>
int main() {
    std::vector<int> values;
    int n;
    while (std::cin >> n) values.push_back(n);
    long long best = 0;
    for (size_t a = 0; a < values.size(); a++) best = best > values[a] ? best : values[a];
    std::cout << best << std::endl;
}`;

const score = (a: string, b: string) => compare(prepare(a), prepare(b)).score;

describe("tokenize", () => {
    it("ignores comments and whitespace and normalizes names, numbers and strings", () => {
        const tokens = tokenize('int x = 42; // c\ns = "a\\"b"; /* m */ y');
        expect(tokens.map((t) => t.text)).toEqual([
            "int",
            "I",
            "=",
            "N",
            ";",
            "I",
            "=",
            "S",
            ";",
            "I",
        ]);
        expect(tokens[0]).toMatchObject({ start: 0, end: 3 });
    });

    it("always advances, whatever the bytes", () => {
        expect(tokenize("\u0000\u{1F600}'unterminated\n\"also").length).toBeGreaterThan(0);
        expect(tokenize("")).toEqual([]);
    });
});

describe("compare", () => {
    it("scores a copy with renamed variables, other numbers and other comments as the same", () => {
        expect(score(ORIGINAL, RENAMED)).toBe(1);
    });

    it("scores an unrelated program low, and itself 1", () => {
        expect(score(ORIGINAL, DIFFERENT)).toBeLessThan(0.2);
        expect(score(DIFFERENT, DIFFERENT)).toBe(1);
    });

    it("notices a changed structure", () => {
        const restructured = `int main() { int t = 0; int i = 0; while (i < 10) { t = t + helper(i); i = i + 1; } return t; }`;
        expect(score(ORIGINAL, restructured)).toBeLessThan(0.6);
    });

    it("returns the matching spans in each source, within bounds", () => {
        const result = compare(prepare(ORIGINAL), prepare(RENAMED));
        expect(result.spansA.length).toBeGreaterThan(0);
        for (const span of result.spansA) {
            expect(span.start).toBeLessThan(span.end);
            expect(span.end).toBeLessThanOrEqual(ORIGINAL.length);
        }
        for (const span of result.spansB) expect(span.end).toBeLessThanOrEqual(RENAMED.length);
    });

    it("has nothing to say about empty or tiny sources", () => {
        expect(score("", ORIGINAL)).toBe(0);
        expect(score("x", "x")).toBe(0);
        expect(fingerprints(tokenize("a b c"))).toEqual([]);
    });
});

describe("similarPairs", () => {
    it("finds the planted copies among unrelated programs, best first", () => {
        let state = 11;
        const next = (n: number) => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state % n;
        };
        // Random token soup: unrelated programs differ in structure, so chance matches are rare.
        const pieces = [
            "v",
            "7",
            "+",
            "-",
            "*",
            "(",
            ")",
            "{",
            "}",
            "if",
            "for",
            "return",
            "=",
            "<",
            ";",
            "[",
            "]",
        ];
        const unrelated = (_seed: number) =>
            Array.from({ length: 14 }, () =>
                Array.from({ length: 8 }, () => pieces[next(pieces.length)]).join(" "),
            ).join("\n");
        const sources = Array.from({ length: 40 }, (_, i) => unrelated(i));
        // Plant copies of answer 3 (as answer 10, with renames) and of answer 7 (as answer 30).
        sources[10] = (sources[3] ?? "").replaceAll("v", "name").replaceAll("7", "9");
        sources[30] = `${sources[7] ?? ""}\n// extra\nz = 1;`;
        const pairs = similarPairs(sources, { scoreMin: 0.5, pairsMax: 10 });
        expect(pairs.slice(0, 2).map((p) => [p.a, p.b])).toEqual(
            expect.arrayContaining([
                [3, 10],
                [7, 30],
            ]),
        );
        expect(pairs.length).toBeLessThanOrEqual(10);
    });

    it("ignores boilerplate held by more answers than the cap, and refuses a bad threshold", () => {
        const sources = Array.from({ length: 60 }, () => ORIGINAL);
        expect(similarPairs(sources, { scoreMin: 0.5, pairsMax: 100 })).toEqual([]);
        expect(() => similarPairs([], { scoreMin: 0, pairsMax: 1 })).toThrow();
    });
});
