// Goal: the webhook signature check accepts exactly what Stripe's documented scheme produces and nothing else. The expected
// signatures here are computed in the test with node:crypto directly, not with the code under test.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { STRIPE_TOLERANCE_S, verifyStripeSignature } from "./stripe-signature.ts";

const SECRET = "whsec_test_secret_value";
const BODY = '{"id":"evt_1","type":"checkout.session.completed"}';
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const sign = (body: string, t: number, secret = SECRET) =>
    createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
const header = (t: number, ...signatures: string[]) =>
    [`t=${t}`, ...signatures.map((s) => `v1=${s}`)].join(",");

describe("verifyStripeSignature", () => {
    it("accepts the documented scheme", () => {
        expect(verifyStripeSignature(BODY, header(NOW_S, sign(BODY, NOW_S)), SECRET, NOW_MS)).toBe(
            "ok",
        );
    });

    it("accepts when any one of several v1 signatures matches (secret rotation)", () => {
        const old = sign(BODY, NOW_S, "whsec_old_old_old_old");
        expect(
            verifyStripeSignature(BODY, header(NOW_S, old, sign(BODY, NOW_S)), SECRET, NOW_MS),
        ).toBe("ok");
    });

    it("refuses a changed body, another secret, another timestamp and a changed signature", () => {
        const good = sign(BODY, NOW_S);
        expect(verifyStripeSignature(`${BODY} `, header(NOW_S, good), SECRET, NOW_MS)).toBe(
            "mismatch",
        );
        expect(
            verifyStripeSignature(
                BODY,
                header(NOW_S, sign(BODY, NOW_S, "whsec_other_other_x")),
                SECRET,
                NOW_MS,
            ),
        ).toBe("mismatch");
        expect(verifyStripeSignature(BODY, header(NOW_S + 1, good), SECRET, NOW_MS)).toBe(
            "mismatch",
        );
        const flipped = `${good.slice(0, 63)}${good.endsWith("0") ? "1" : "0"}`;
        expect(verifyStripeSignature(BODY, header(NOW_S, flipped), SECRET, NOW_MS)).toBe(
            "mismatch",
        );
    });

    it("refuses a genuine signature that is too old or from the future, and accepts the edge", () => {
        const at = (t: number) =>
            verifyStripeSignature(BODY, header(t, sign(BODY, t)), SECRET, NOW_MS);
        expect(at(NOW_S - STRIPE_TOLERANCE_S)).toBe("ok");
        expect(at(NOW_S - STRIPE_TOLERANCE_S - 1)).toBe("expired");
        expect(at(NOW_S + STRIPE_TOLERANCE_S)).toBe("ok");
        expect(at(NOW_S + STRIPE_TOLERANCE_S + 1)).toBe("expired");
    });
});

describe("verifyStripeSignature, malformed input", () => {
    it("refuses malformed headers without throwing", () => {
        const good = sign(BODY, NOW_S);
        for (const bad of [
            undefined,
            "",
            "garbage",
            `t=${NOW_S}`,
            `v1=${good}`,
            `t=abc,v1=${good}`,
            `t=${NOW_S},v1=nothex`,
            `t=${NOW_S},v1=${good.slice(1)}`,
            `t=${NOW_S},=,v1=${good}`,
            "x".repeat(2000),
        ])
            expect(verifyStripeSignature(BODY, bad, SECRET, NOW_MS), String(bad)).toBe("malformed");
    });

    it("ignores unknown schemes such as v0 but does not accept them", () => {
        const good = sign(BODY, NOW_S);
        expect(verifyStripeSignature(BODY, `t=${NOW_S},v0=${good}`, SECRET, NOW_MS)).toBe(
            "malformed",
        );
        expect(
            verifyStripeSignature(BODY, `t=${NOW_S},v0=${good},v1=${good}`, SECRET, NOW_MS),
        ).toBe("ok");
    });
});
