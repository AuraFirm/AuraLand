// Goal: the operator's tool reads loose leaked files and a candidates export and says who they point to,
// exiting 0 only for a strong match, and fails loudly on a candidates file it does not understand.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { embedWatermark } from "./watermark.ts";

const CLI = new URL("./trace-leak-cli.ts", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "aura-trace-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const enc = new TextEncoder();
function leakOf(tag: number, name: string): string {
    const files = new Map<string, Uint8Array>();
    for (let t = 1; t <= 3; t++) {
        files.set(
            `tests/00${t}.ans`,
            enc.encode(`${Array.from({ length: 40 }, (_, i) => t * 1000 + i).join("\n")}\n`),
        );
    }
    const dir = join(root, name);
    mkdirSync(dir);
    for (const [path, bytes] of embedWatermark(files, tag, "tokens").files) {
        writeFileSync(join(dir, path.split("/")[1] ?? "x"), bytes);
    }
    return dir;
}
function candidatesFile(name: string, body: unknown): string {
    const path = join(root, `${name}.json`);
    writeFileSync(path, JSON.stringify(body));
    return path;
}
const run = (leaked: string, candidates: string) =>
    spawnSync("node", [CLI, "--leaked", leaked, "--candidates", candidates], { encoding: "utf8" });

describe("trace-leak-cli", () => {
    const records = [
        { deliveryId: "dlv-1", taskVersionId: "tsv-1", tag: 0xdeadbeef },
        { deliveryId: "dlv-2", taskVersionId: "tsv-1", tag: 0xcafef00d },
    ];

    it("names the delivery of a directory of leaked answers, and of a single file", () => {
        const dir = leakOf(0xdeadbeef, "whole");
        const whole = run(dir, candidatesFile("ok", records));
        expect(whole.status).toBe(0);
        expect(whole.stdout).toContain("STRONG: delivery dlv-1");
        expect(whole.stdout).not.toContain("dlv-2");
        const single = run(join(dir, "002.ans"), candidatesFile("ok2", records));
        expect(single.stdout).toContain("STRONG: delivery dlv-1");
    });

    it("says nobody matches, and exits 1, when the files carry no mark", () => {
        const dir = join(root, "plain");
        mkdirSync(dir);
        writeFileSync(join(dir, "001.ans"), "1\n2\n3\n");
        const result = run(dir, candidatesFile("ok3", records));
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("no delivery matches");
    });

    it("refuses a candidates file it does not understand and a missing argument", () => {
        const dir = leakOf(0xdeadbeef, "again");
        const bad = run(dir, candidatesFile("bad", [{ deliveryId: 1 }]));
        expect(bad.status).not.toBe(0);
        expect(bad.stderr).toContain("candidate 0");
        const none = spawnSync("node", [CLI], { encoding: "utf8" });
        expect(none.status).toBe(2);
    });
});
