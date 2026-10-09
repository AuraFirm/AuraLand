import { type NextRequest, NextResponse } from "next/server";
import { buildCsp, generateNonce } from "./lib/csp.ts";

// Next.js 16 calls this file "proxy" (formerly "middleware"). It does exactly one job: attach a
// per-request CSP nonce. It must never make authentication decisions (docs/kit/03 section 3):
// authorization lives in the API and in PostgreSQL, so bypassing this file exposes nothing.
export function proxy(request: NextRequest): NextResponse {
    const nonce = generateNonce();
    // tigerlint-allow: env-only-in-config -- NODE_ENV is inlined by Next.js at build time
    const csp = buildCsp(nonce, process.env.NODE_ENV === "development");
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);
    // Next.js reads the nonce from the request-side policy and applies it to its own scripts.
    requestHeaders.set("Content-Security-Policy", csp);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("Content-Security-Policy", csp);
    // The nonce is unique to this response, so no shared cache may store it.
    response.headers.set("Cache-Control", "private, no-store");
    return response;
}

export const config = {
    // Static assets and the health probe carry no nonce and may be cached.
    matcher: [
        {
            source: "/((?!_next/static|_next/image|favicon.ico|healthz).*)",
            missing: [{ type: "header", key: "next-router-prefetch" }],
        },
    ],
};
