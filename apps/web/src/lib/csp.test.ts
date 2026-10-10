// Goal: the CSP must be strict in production, relaxed only for development needs, and must
// refuse a malformed nonce so a bug cannot ship a policy that blocks (or allows) everything.
import { describe, expect, it } from "vitest";
import { buildCsp, generateNonce } from "./csp.ts";
import { STATIC_SECURITY_HEADERS } from "./security-headers.ts";

describe("nonce", () => {
    it("is 128 bits of base64 and differs between calls", () => {
        const a = generateNonce();
        expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
        expect(generateNonce()).not.toBe(a);
    });
});

describe("buildCsp", () => {
    const nonce = generateNonce();

    it("adds extra connect origins only when asked, and only bare origins", () => {
        expect(buildCsp(nonce, false)).toContain("connect-src 'self';");
        const upload = buildCsp(nonce, false, ["https://s3.example"]);
        expect(upload).toContain("connect-src 'self' https://s3.example;");
        expect(upload).not.toContain("*");
        for (const bad of [
            "*",
            "https://s3.example/path",
            "https://a b",
            "javascript:x",
            "https://x;script-src *",
        ]) {
            expect(() => buildCsp(nonce, false, [bad]), bad).toThrow();
        }
    });

    it("is strict in production", () => {
        const csp = buildCsp(nonce, false);
        expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("base-uri 'none'");
        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("upgrade-insecure-requests");
        expect(csp).not.toContain("unsafe-eval");
        expect(csp).not.toContain("unsafe-inline");
    });

    it("relaxes only eval and inline styles in development", () => {
        const csp = buildCsp(nonce, true);
        expect(csp).toContain("'unsafe-eval'");
        expect(csp).toContain("style-src 'self' 'unsafe-inline'");
        expect(csp).not.toContain("upgrade-insecure-requests");
        expect(csp).toContain("object-src 'none'");
    });

    it("rejects malformed nonces, including injection attempts", () => {
        for (const bad of ["", "short", "a b", "x'; script-src *; '", `${nonce}x`]) {
            expect(() => buildCsp(bad, false)).toThrow(/nonce/);
        }
    });
});

describe("static security headers", () => {
    it("includes HSTS with preload, nosniff and frame denial", () => {
        const byKey = new Map(STATIC_SECURITY_HEADERS.map((h) => [h.key, h.value]));
        expect(byKey.get("Strict-Transport-Security")).toContain("preload");
        expect(byKey.get("X-Content-Type-Options")).toBe("nosniff");
        expect(byKey.get("X-Frame-Options")).toBe("DENY");
        expect(byKey.get("Permissions-Policy")).toContain("camera=()");
    });
});
