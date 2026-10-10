import { assert } from "@aura/contracts/assert";

// Content Security Policy for HTML responses (docs/kit/08 section 5). A fresh nonce per request
// lets Next.js scripts run while blocking every injected script, and `strict-dynamic` lets those
// scripts load their own chunks. Because the nonce changes per request, nonce-bearing HTML must
// never be cached by a shared cache: the proxy marks such responses `private, no-store`.

const NONCE_BYTES = 16; // 128 bits, as recommended by the CSP specification.

export function generateNonce(): string {
    const bytes = new Uint8Array(NONCE_BYTES);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes));
}

// `connectOrigins` are extra origins scripts may talk to. Only the upload page passes one: the object
// storage origin its presigned part URLs point at. Every other page keeps `connect-src 'self'`.
export function buildCsp(
    nonce: string,
    isDevelopment: boolean,
    connectOrigins: readonly string[] = [],
): string {
    assert(/^[A-Za-z0-9+/]{22}==$/.test(nonce), "nonce is 16 random bytes in base64");
    for (const origin of connectOrigins) {
        assert(
            /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin),
            "a connect origin is a bare origin",
        );
    }
    // The development server needs eval for React refresh; production never does.
    const scriptSources = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
    if (isDevelopment) scriptSources.push("'unsafe-eval'");
    const styleSources = isDevelopment
        ? ["'self'", "'unsafe-inline'"]
        : ["'self'", `'nonce-${nonce}'`];
    const directives = [
        "default-src 'none'",
        `script-src ${scriptSources.join(" ")}`,
        `style-src ${styleSources.join(" ")}`,
        "img-src 'self' data: blob:",
        "font-src 'self'",
        `connect-src ${["'self'", ...connectOrigins].join(" ")}`,
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ];
    if (!isDevelopment) directives.push("upgrade-insecure-requests");
    return directives.join("; ");
}
