// Goal: a node's signature binds the method, path and query, timestamp, nonce and exact body, and only
// the node's own key verifies it; malformed keys and signatures are refused without throwing.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newKey } from "../../http-judge-support.ts";
import { canonicalText, type SignedParts, verifySignature } from "./signing.ts";

const parts: SignedParts = {
    method: "POST",
    target: "/api/judge/v1/lease?x=1",
    timestampMs: 1_800_000_000_000,
    nonce: "abcdefghijklmnop",
    body: '{"a":1}',
};
const key = newKey();
const signature = key.sign(canonicalText(parts));

describe("verifySignature", () => {
    it("accepts the exact request signed by the node's key", () => {
        expect(verifySignature(key.publicKey, parts, signature)).toBe(true);
    });

    it("rejects any change to what was signed", () => {
        const changes: Array<Partial<SignedParts>> = [
            { method: "GET" },
            { target: "/api/judge/v1/lease?x=2" },
            { target: "/api/judge/v1/lease" },
            { timestampMs: parts.timestampMs + 1 },
            { nonce: "abcdefghijklmnoq" },
            { body: '{"a":2}' },
            { body: "" },
        ];
        for (const change of changes) {
            expect(
                verifySignature(key.publicKey, { ...parts, ...change }, signature),
                JSON.stringify(change),
            ).toBe(false);
        }
    });

    it("treats the method case-insensitively, because HTTP stacks differ", () => {
        expect(verifySignature(key.publicKey, { ...parts, method: "post" }, signature)).toBe(true);
    });

    it("rejects another key, short or long keys and signatures, and a flipped bit", () => {
        expect(verifySignature(newKey().publicKey, parts, signature)).toBe(false);
        expect(verifySignature(key.publicKey.subarray(1), parts, signature)).toBe(false);
        expect(verifySignature(randomBytes(33), parts, signature)).toBe(false);
        expect(verifySignature(key.publicKey, parts, signature.subarray(1))).toBe(false);
        const flipped = Buffer.from(signature);
        flipped[0] = (flipped[0] ?? 0) ^ 1;
        expect(verifySignature(key.publicKey, parts, flipped)).toBe(false);
    });
});
