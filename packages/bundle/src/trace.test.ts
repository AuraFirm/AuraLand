// Goal: the leak trace names the delivery a leaked file came from, whole or in part, and names nobody
// when the marks are gone or were never there. Method: mark one task for several deliveries, "leak" it in
// different ways, trace against hundreds of candidates.
import { describe, expect, it } from "vitest";
import { type Candidate, traceLeak } from "./trace.ts";
import { embedWatermark, type Files, TAG_MARKER } from "./watermark.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function task(): Map<string, Uint8Array> {
    const files = new Map<string, Uint8Array>();
    for (let t = 1; t <= 6; t++) {
        const id = `00${t}`;
        files.set(`tests/${id}.in`, enc.encode(`${t}\n`));
        files.set(
            `tests/${id}.ans`,
            enc.encode(`${Array.from({ length: 40 }, (_, i) => t * 1000 + i).join("\n")}\n`),
        );
    }
    files.set("solutions/reference.cpp", enc.encode("int main(){}\n"));
    files.set("solutions/wrong_a.py", enc.encode("print(0)\n"));
    return files;
}

// Deterministic "random" tags: many other deliveries on record besides the real ones.
function others(count: number): Candidate[] {
    let state = 99;
    return Array.from({ length: count }, (_, i) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return {
            deliveryId: `other-${i}`,
            taskVersionId: "v",
            tag: (TAG_MARKER + (state % 2 ** 31)) >>> 0,
        };
    });
}

const A: Candidate = { deliveryId: "delivery-a", taskVersionId: "v", tag: 0xdeadbeef };
const B: Candidate = { deliveryId: "delivery-b", taskVersionId: "v", tag: 0xcafef00d };
const candidates = [...others(500), A, B];
const markedFor = (candidate: Candidate) => embedWatermark(task(), candidate.tag, "tokens").files;
const subset = (files: Files, keep: (path: string) => boolean) =>
    new Map([...files].filter(([path]) => keep(path)));
const names = (trace: ReturnType<typeof traceLeak>) =>
    trace.matches.map((m) => m.candidate.deliveryId);

describe("traceLeak", () => {
    it("names the delivery of a verbatim copy, strongly, and nobody else", () => {
        const trace = traceLeak(markedFor(A), candidates);
        expect(names(trace)).toEqual(["delivery-a"]);
        expect(trace.matches[0]?.strength).toBe("strong");
        expect(trace.matches[0]?.solutionMarks).toBe(2);
        expect(trace.matches[0]?.answerBitsAgreeing).toBe(32);
    });

    it("tells two deliveries of the same task apart", () => {
        expect(names(traceLeak(markedFor(B), candidates))).toEqual(["delivery-b"]);
    });

    it("still finds the delivery when only some files leaked", () => {
        const marked = markedFor(A);
        const oneAnswer = subset(marked, (p) => p === "tests/004.ans");
        expect(names(traceLeak(oneAnswer, candidates))).toEqual(["delivery-a"]);
        const onlySolution = subset(marked, (p) => p === "solutions/wrong_a.py");
        expect(names(traceLeak(onlySolution, candidates))).toEqual(["delivery-a"]);
        const noSolutions = subset(marked, (p) => !p.startsWith("solutions/"));
        expect(names(traceLeak(noSolutions, candidates))).toEqual(["delivery-a"]);
    });
});

describe("traceLeak, fragments and scrubbing", () => {
    it("calls a short fragment only possible, never strong", () => {
        const marked = markedFor(A);
        const fragment = new Map([
            [
                "tests/002.ans",
                enc.encode(
                    dec.decode(marked.get("tests/002.ans")).split("\n").slice(0, 12).join("\n"),
                ),
            ],
        ]);
        const trace = traceLeak(fragment, [A, ...others(50)]);
        const match = trace.matches.find((m) => m.candidate.deliveryId === "delivery-a");
        expect(match?.strength).toBe("possible");
        expect(trace.answerBitsKnown).toBe(12);
    });

    it("loses the answers to a leaker who normalizes whitespace but still finds the solutions", () => {
        const normalized = new Map(
            [...markedFor(A)].map(([path, bytes]) => [
                path,
                path.endsWith(".ans")
                    ? enc.encode(dec.decode(bytes).replace(/[ \t]+$/gm, ""))
                    : bytes,
            ]),
        );
        const trace = traceLeak(normalized, candidates);
        expect(names(trace)).toEqual(["delivery-a"]);
        expect(trace.matches[0]?.answerBitsAgreeing).toBe(0);
        expect(trace.matches[0]?.solutionMarks).toBe(2);
    });

    it("finds nothing once the answers are normalized and the solution comments are stripped", () => {
        const scrubbed = new Map(
            [...markedFor(A)].map(([path, bytes]) => [
                path,
                path.endsWith(".ans")
                    ? enc.encode(dec.decode(bytes).replace(/[ \t]+$/gm, ""))
                    : path.startsWith("solutions/")
                      ? enc.encode(dec.decode(bytes).replace(/^.*aura-wm:.*\n?/gm, ""))
                      : bytes,
            ]),
        );
        const trace = traceLeak(scrubbed, candidates);
        expect(trace.matches).toEqual([]);
        expect(trace.answerBitsKnown).toBe(0);
    });

    it("finds nothing in the original, unmarked files", () => {
        expect(traceLeak(task(), candidates).matches).toEqual([]);
    });

    it("does not blame a delivery whose tag disagrees with even one known bit", () => {
        const marked = markedFor(A);
        const flipped: Candidate = { ...A, deliveryId: "near-miss", tag: (A.tag ^ 4) >>> 0 };
        expect(names(traceLeak(marked, [flipped]))).toEqual([]);
    });
});
