// Goal: the manifest is a pure, deterministic function of its input; any change to any ordered fact
// changes the hash; the canary in a statement is unique per delivery and per version; and building
// refuses an input whose versions are no longer all released.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SPEC } from "../../http-task-support.ts";
import { type BuildInput, buildInputSchema, buildManifest, deliveryCanary } from "./rules.ts";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const U = (n: number) => `018f0000-0000-7000-8000-0000000000${n.toString(16).padStart(2, "0")}`;

function input(overrides: Partial<BuildInput> = {}): BuildInput {
    return buildInputSchema.parse({
        delivery_id: U(1),
        order_id: U(2),
        customer_org_id: U(3),
        watermark_id: "0123456789abcdef0123456789abcdef",
        created_at: "2026-10-12T10:00:00+00:00",
        expires_at: "2026-11-11T10:00:00+00:00",
        licence_terms: "Internal evaluation use only.",
        expected_item_count: 1,
        items: [
            {
                task_version_id: U(10),
                task_id: U(11),
                seq: 1,
                spec: SPEC,
                statement: "Add two numbers.",
                bundle_sha256: "a".repeat(64),
                bundle_bytes: 1234,
                waived: false,
                validation: null,
            },
        ],
        ...overrides,
    });
}

describe("buildManifest", () => {
    it("gives the same text and hash for the same input", () => {
        expect(buildManifest(input(), sha)).toEqual(buildManifest(input(), sha));
    });

    it("changes the hash when any ordered fact changes", () => {
        const base = buildManifest(input(), sha).sha256Hex;
        const first = input().items[0];
        if (first === undefined) throw new Error("fixture has one item");
        const variants: BuildInput[] = [
            input({ licence_terms: "Other terms." }),
            input({ watermark_id: "f".repeat(32) }),
            input({ expires_at: "2026-11-12T10:00:00+00:00" }),
            input({ items: [{ ...first, statement: "Add three numbers." }] }),
            input({ items: [{ ...first, bundle_sha256: "b".repeat(64) }] }),
            input({ items: [{ ...first, bundle_bytes: 1235 }] }),
            input({ items: [{ ...first, waived: true }] }),
        ];
        const hashes = new Set(variants.map((variant) => buildManifest(variant, sha).sha256Hex));
        expect(hashes.size).toBe(variants.length);
        expect(hashes.has(base)).toBe(false);
    });

    it("puts the canary into the statement and says validation was not performed", () => {
        const parsed = JSON.parse(buildManifest(input(), sha).text);
        const item = parsed.items[0];
        expect(item.statement).toContain(
            deliveryCanary("0123456789abcdef0123456789abcdef", U(10), sha),
        );
        expect(item.validation).toBe("not performed");
        expect(item.bundle).toEqual({ sha256: "a".repeat(64), bytes: 1234 });
    });

    it("says only what the validation evidence supports, and plain validated only for production", () => {
        const first = input().items[0];
        if (first === undefined) throw new Error("fixture has one item");
        const report = { report_id: U(20), score: 91.5, score_version: 1 };
        const say = (validation: BuildInput["items"][number]["validation"], waived = false) =>
            JSON.parse(
                buildManifest(input({ items: [{ ...first, waived, validation }] }), sha).text,
            ).items[0].validation;
        expect(say(null, true)).toBe("waived by a reviewer; not performed");
        const production = say({ ...report, attestation: "production" });
        expect(production).toMatch(
            /^validated \(production sandbox\), score 91.5\/100 \(formula v1\), report vrp_/,
        );
        const development = say({ ...report, attestation: "development" });
        expect(development).toContain("development sandbox only");
        expect(development).toContain("not been independently reviewed");
        expect(development.startsWith("validated (")).toBe(false);
        expect(
            say({ ...report, attestation: "development", score: null, score_version: null }),
        ).not.toContain("score");
    });

    it("refuses a missing version and an empty delivery", () => {
        expect(() => buildManifest(input({ expected_item_count: 2 }), sha)).toThrow(
            /still released/,
        );
        expect(() => buildManifest(input({ expected_item_count: 1, items: [] }), sha)).toThrow();
    });
});

describe("deliveryCanary", () => {
    it("differs per delivery and per version, and reveals neither", () => {
        const a = deliveryCanary("a".repeat(32), U(10), sha);
        expect(a).toMatch(/^ref-[0-9a-f]{16}$/);
        expect(deliveryCanary("b".repeat(32), U(10), sha)).not.toBe(a);
        expect(deliveryCanary("a".repeat(32), U(11), sha)).not.toBe(a);
        expect(a).not.toContain("a".repeat(8));
    });
});
