// Goal: the customer's verification refuses a changed manifest, a changed bundle, a missing bundle and
// a wrong size, and accepts the genuine delivery. Each case changes exactly one thing.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyDelivery } from "./verify-delivery.ts";

const bundle = new TextEncoder().encode("bundle bytes");
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.stringify({
    items: [{ bundle: { sha256: sha(bundle), bytes: bundle.length } }],
});
const files = [{ name: "a.tar.zst", bytes: bundle }];

describe("verifyDelivery", () => {
    it("accepts the genuine delivery", () => {
        expect(verifyDelivery(manifest, sha(manifest), files)).toEqual({
            problems: [],
            itemCount: 1,
        });
    });

    it("refuses a manifest whose hash is not the published one", () => {
        const result = verifyDelivery(`${manifest} `, sha(manifest), files);
        expect(result.problems[0]).toMatch(/published hash/);
    });

    it("refuses a changed, a missing and a wrongly sized bundle", () => {
        const changed = [{ name: "a.tar.zst", bytes: new TextEncoder().encode("bundle bytez") }];
        expect(verifyDelivery(manifest, null, changed).problems[0]).toMatch(/no file with SHA-256/);
        expect(verifyDelivery(manifest, null, []).problems[0]).toMatch(/no file with SHA-256/);
        const wrongSize = JSON.stringify({
            items: [{ bundle: { sha256: sha(bundle), bytes: 3 } }],
        });
        expect(verifyDelivery(wrongSize, null, files).problems[0]).toMatch(/expected 3/);
    });

    it("refuses text that is not a manifest", () => {
        expect(verifyDelivery("not json", null, files).problems).toContain(
            "the manifest is not valid JSON",
        );
        expect(verifyDelivery("[]", null, files).problems).toContain(
            "the manifest is not an object",
        );
        expect(verifyDelivery('{"items":[{}]}', null, files).problems).toContain(
            "an item has no valid bundle entry",
        );
    });
});
