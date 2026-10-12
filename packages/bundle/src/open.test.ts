import { describe, expect, it } from "vitest";
import { corpusCases } from "./corpus.ts";
import { openAndEncode } from "./open.ts";

// Goal: the stream a box prints for a bundle is exactly what the Go reader expects, for a good bundle,
// a refused one, and a bundle with solutions. Method: decode the stream by the documented grammar.
function decode(stream: Uint8Array) {
    const text = Buffer.from(stream);
    const files = new Map<string, string>();
    let at = text.indexOf("\n") + 1;
    expect(text.subarray(0, at).toString()).toBe("AURA-OPEN 1\n");
    for (let record = 0; record <= 100; record++) {
        const lineEnd = text.indexOf("\n", at);
        const [first = "", digest = "", path = ""] = text
            .subarray(at, lineEnd)
            .toString()
            .split(" ");
        if (first === "END") return { files, count: Number(digest) };
        const size = Number(first);
        files.set(path, text.subarray(lineEnd + 1, lineEnd + 1 + size).toString());
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
        at = lineEnd + 1 + size + 1;
    }
    throw new Error("no trailer within 100 records");
}

const byName = (name: string) => {
    const found = corpusCases().find((c) => c.name === name);
    if (found === undefined) throw new Error(`no corpus case ${name}`);
    return found;
};

describe("openAndEncode", () => {
    it("exports tests and solutions only", () => {
        const { files, count } = decode(openAndEncode(byName("golden-rich").bytes));
        expect([...files.keys()]).toEqual([
            "solutions/reference.cpp",
            "solutions/wrong_off_by_one.py",
            "tests/001.ans",
            "tests/001.in",
            "tests/002.ans",
            "tests/002.in",
        ]);
        expect(count).toBe(6);
        expect(files.get("tests/002.in")).toBe("40 2\n");
    });

    it("reports a refusal as one line and nothing else", () => {
        const out = Buffer.from(openAndEncode(byName("layout-no-statement").bytes)).toString();
        expect(out).toBe("REFUSED missing_file statement/en.md\n");
    });

    it("refuses garbage without throwing", () => {
        const out = Buffer.from(openAndEncode(new Uint8Array([1, 2, 3]))).toString();
        expect(out.startsWith("REFUSED ")).toBe(true);
        expect(out.endsWith("\n")).toBe(true);
    });
});
