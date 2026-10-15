import { createHmac, timingSafeEqual } from "node:crypto";

// Stripe's webhook signature, written from its documentation so no SDK is needed: the header is `t=<unix seconds>,v1=<hex>[,v1=...]`
// and each v1 is HMAC-SHA-256, keyed by the endpoint secret, of `<t>.<raw body>`. A request is accepted only when some v1 matches
// AND t is within the tolerance of now (a captured request cannot be replayed later). The comparison is constant-time and the body
// is the exact bytes received, so nothing is parsed before the signature is checked.

export const STRIPE_TOLERANCE_S = 300; // Stripe's documented default replay window, five minutes.
const HEADER_BYTES_MAX = 1024;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

export type SignatureVerdict = "ok" | "malformed" | "mismatch" | "expired";

export function verifyStripeSignature(
    rawBody: string,
    header: string | undefined,
    secret: string,
    nowMs: number,
): SignatureVerdict {
    if (header === undefined || header.length === 0 || header.length > HEADER_BYTES_MAX)
        return "malformed";
    let timestampS: number | null = null;
    const candidates: string[] = [];
    for (const part of header.split(",")) {
        const at = part.indexOf("=");
        if (at < 1) return "malformed";
        const [name, value] = [part.slice(0, at).trim(), part.slice(at + 1).trim()];
        if (name === "t" && /^[0-9]{1,12}$/.test(value)) timestampS = Number(value);
        else if (name === "v1" && HEX_SHA256.test(value)) candidates.push(value);
    }
    if (timestampS === null || candidates.length === 0) return "malformed";
    const expected = createHmac("sha256", secret).update(`${timestampS}.${rawBody}`).digest();
    const matched = candidates.some((hex) => timingSafeEqual(expected, Buffer.from(hex, "hex")));
    if (!matched) return "mismatch";
    // The signature is genuine; only now is the age worth checking. Both directions: a timestamp from the future is as suspect.
    if (Math.abs(nowMs / 1000 - timestampS) > STRIPE_TOLERANCE_S) return "expired";
    return "ok";
}
