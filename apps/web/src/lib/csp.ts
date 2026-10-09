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

export function buildCsp(nonce: string, isDevelopment: boolean): string {
    assert(/^[A-Za-z0-9+/]{22}==$/.test(nonce), "nonce is 16 random bytes in base64");
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
        "connect-src 'self'",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ];
    if (!isDevelopment) directives.push("upgrade-insecure-requests");
    return directives.join("; ");
}
