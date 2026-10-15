// Goal: a delivery is signed so that a receiver following the documented scheme accepts it (the expected values here are computed
// directly with node:crypto), the previous secret signs only during its overlap, and the retry schedule doubles, is capped, and
// ends exactly at the 24-hour window.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    DELIVERY_WINDOW_MS,
    nextAttemptAtMs,
    SECRET_OVERLAP_MS,
    signatureHeader,
    signingSecrets,
} from "./rules.ts";

const NOW = 1_800_000_000_000;
const A = "a".repeat(64);
const B = "b".repeat(64);
const hmac = (secret: string, t: number, body: string) =>
    createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

describe("signatureHeader", () => {
    it("is t=<seconds>,v1=<hmac of 't.body'>", () => {
        expect(signatureHeader([A], NOW, '{"x":1}')).toBe(
            `t=${NOW / 1000},v1=${hmac(A, NOW / 1000, '{"x":1}')}`,
        );
    });
    it("carries one v1 per secret, current first", () => {
        expect(signatureHeader([A, B], NOW + 999, "{}")).toBe(
            `t=${NOW / 1000},v1=${hmac(A, NOW / 1000, "{}")},v1=${hmac(B, NOW / 1000, "{}")}`,
        );
    });
    it("changes with the body and with the secret", () => {
        expect(signatureHeader([A], NOW, "{}")).not.toBe(signatureHeader([A], NOW, "{ }"));
        expect(signatureHeader([A], NOW, "{}")).not.toBe(signatureHeader([B], NOW, "{}"));
    });
    it("refuses no secret and too many", () => {
        expect(() => signatureHeader([], NOW, "{}")).toThrow();
        expect(() => signatureHeader([A, B, A], NOW, "{}")).toThrow();
    });
});

describe("signingSecrets", () => {
    it("uses the previous secret only during the overlap after a rotation", () => {
        const rotated = { current: A, previous: B, rotatedAtMs: NOW };
        expect(signingSecrets(rotated, NOW + SECRET_OVERLAP_MS - 1)).toEqual([A, B]);
        expect(signingSecrets(rotated, NOW + SECRET_OVERLAP_MS)).toEqual([A]);
        expect(signingSecrets({ current: A, previous: null, rotatedAtMs: null }, NOW)).toEqual([A]);
    });
});

describe("nextAttemptAtMs", () => {
    const created = NOW;
    it("doubles from 30 seconds up to four hours", () => {
        const delays = [1, 2, 3, 4, 10, 11, 12]
            .map((made) => nextAttemptAtMs(created, created + 1, made) ?? -1)
            .map((at) => at - created - 1);
        expect(delays.slice(0, 4)).toEqual([30_000, 60_000, 120_000, 240_000]);
        expect(delays.slice(4)).toEqual([4 * 3600_000, 4 * 3600_000, 4 * 3600_000]);
    });
    it("makes its last try exactly at the end of the window and gives up after it", () => {
        const late = created + DELIVERY_WINDOW_MS - 1000;
        expect(nextAttemptAtMs(created, late, 9)).toBe(created + DELIVERY_WINDOW_MS);
        expect(nextAttemptAtMs(created, created + DELIVERY_WINDOW_MS, 10)).toBeNull();
        expect(nextAttemptAtMs(created, created + DELIVERY_WINDOW_MS + 5, 1)).toBeNull();
    });
    it("is only asked after an attempt", () => {
        expect(() => nextAttemptAtMs(created, created, 0)).toThrow();
    });
});
