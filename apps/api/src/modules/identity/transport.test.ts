// Goal: the session cookie and the cross-site request check are the front door of every logged-in
// request, so their pure rules are tested exhaustively: exact attributes, strict parsing that
// refuses duplicates and junk, and a CSRF decision table with no gaps.
import { describe, expect, it } from "vitest";
import {
    type CsrfInput,
    evaluateCsrf,
    parseSessionCookie,
    serializeClearedCookie,
    serializeSessionCookie,
    sessionCookieName,
} from "./rules.ts";

const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ-_";
const GOOD = TOKEN.slice(0, 43);

describe("session cookie names and attributes", () => {
    it("uses the __Host- prefix exactly when the cookie is Secure", () => {
        expect(sessionCookieName(true)).toBe("__Host-aura_session");
        expect(sessionCookieName(false)).toBe("aura_session");
    });

    it("sets the full attribute set in production, in a fixed order, without Domain", () => {
        const cookie = serializeSessionCookie(GOOD, true);
        expect(cookie).toBe(
            `__Host-aura_session=${GOOD}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`,
        );
        expect(cookie).not.toMatch(/Domain/i);
    });

    it("omits Secure only for local development, keeping every other protection", () => {
        const cookie = serializeSessionCookie(GOOD, false);
        expect(cookie).toBe(
            `aura_session=${GOOD}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
        );
    });

    it("clears with Max-Age=0 and the same attributes so the browser matches it", () => {
        expect(serializeClearedCookie(true)).toBe(
            "__Host-aura_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
        );
        expect(serializeClearedCookie(false)).toBe(
            "aura_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        );
    });

    it("refuses to serialize anything that is not a well-formed token, to stop header injection", () => {
        for (const bad of [
            "",
            "short",
            `${GOOD}x`,
            `${GOOD.slice(0, 42)};`,
            `${GOOD.slice(0, 41)}\r\n`,
            "a".repeat(43).replace("a", " "),
        ]) {
            expect(() => serializeSessionCookie(bad, true)).toThrow(/token/);
        }
    });
});

describe("parseSessionCookie", () => {
    const name = sessionCookieName(true);

    it("finds the session cookie among others, with or without spaces", () => {
        expect(parseSessionCookie(`${name}=${GOOD}`, true)).toBe(GOOD);
        expect(parseSessionCookie(`theme=dark; ${name}=${GOOD}; lang=bn`, true)).toBe(GOOD);
        expect(parseSessionCookie(`a=1;${name}=${GOOD}`, true)).toBe(GOOD);
    });

    it("returns null when the cookie is absent, under the wrong name, or has a malformed value", () => {
        expect(parseSessionCookie(undefined, true)).toBeNull();
        expect(parseSessionCookie("", true)).toBeNull();
        expect(parseSessionCookie(`aura_session=${GOOD}`, true)).toBeNull(); // Wrong name for production.
        expect(parseSessionCookie(`x${name}=${GOOD}`, true)).toBeNull();
        expect(parseSessionCookie(`${name}=${GOOD}x`, true)).toBeNull();
        expect(parseSessionCookie(`${name}="${GOOD}"`, true)).toBeNull();
        expect(parseSessionCookie(`${name}=`, true)).toBeNull();
        expect(parseSessionCookie(name, true)).toBeNull();
    });

    it("rejects duplicate cookies of the same name, which is how cookie tossing works", () => {
        expect(parseSessionCookie(`${name}=${GOOD}; ${name}=${GOOD}`, true)).toBeNull();
        expect(
            parseSessionCookie(`${name}=${GOOD}; ${name}=${GOOD.replace("a", "b")}`, true),
        ).toBeNull();
    });

    it("rejects an oversized header outright, exactly above the limit", () => {
        const tail = `; ${name}=${GOOD}`;
        const headerOfLength = (n: number) => `pad=${"x".repeat(n - tail.length - 4)}${tail}`;
        expect(headerOfLength(4096).length).toBe(4096);
        expect(parseSessionCookie(headerOfLength(4096), true)).toBe(GOOD);
        expect(headerOfLength(4097).length).toBe(4097);
        expect(parseSessionCookie(headerOfLength(4097), true)).toBeNull();
    });
});

describe("evaluateCsrf", () => {
    const base: CsrfInput = {
        method: "POST",
        origin: "https://app.example",
        secFetchSite: "same-origin",
        requestHeader: "1",
        allowedOrigin: "https://app.example",
    };
    const check = (overrides: Partial<CsrfInput>) => evaluateCsrf({ ...base, ...overrides });

    it("never blocks safe methods, whatever the headers say", () => {
        for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
            expect(
                check({
                    method,
                    origin: "https://evil.example",
                    requestHeader: null,
                    secFetchSite: "cross-site",
                }).ok,
            ).toBe(true);
        }
    });

    it("allows an unsafe request that is same-origin with the custom header", () => {
        for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"])
            expect(check({ method }).ok).toBe(true);
    });

    it("requires the custom header on every unsafe request", () => {
        for (const requestHeader of [null, "", "0", "true", "11", " 1"]) {
            expect(check({ requestHeader })).toEqual({ ok: false, reason: "missing_header" });
        }
    });
});

describe("evaluateCsrf, origin and browser signals", () => {
    const base: CsrfInput = {
        method: "POST",
        origin: "https://app.example",
        secFetchSite: "same-origin",
        requestHeader: "1",
        allowedOrigin: "https://app.example",
    };
    const check = (overrides: Partial<CsrfInput>) => evaluateCsrf({ ...base, ...overrides });

    it("requires an Origin that equals ours exactly", () => {
        for (const origin of [
            "https://evil.example",
            "http://app.example",
            "https://app.example:8443",
            "https://app.example.evil.example",
            "null",
            "https://APP.example",
        ]) {
            expect(check({ origin })).toEqual({ ok: false, reason: "origin_mismatch" });
        }
    });

    it("without an Origin, accepts only a browser that vouches same-origin", () => {
        expect(check({ origin: null, secFetchSite: "same-origin" }).ok).toBe(true);
        // No Origin and no Sec-Fetch-Site: nothing proves where the request came from.
        expect(check({ origin: null, secFetchSite: null })).toEqual({
            ok: false,
            reason: "no_origin",
        });
        for (const secFetchSite of ["same-site", "cross-site", "none", ""]) {
            expect(check({ origin: null, secFetchSite }), secFetchSite).toEqual({
                ok: false,
                reason: "cross_site",
            });
        }
    });

    it("rejects a browser that says the request is not same-origin, even with a matching Origin", () => {
        for (const secFetchSite of ["same-site", "cross-site", "none"]) {
            expect(check({ secFetchSite })).toEqual({ ok: false, reason: "cross_site" });
        }
    });

    it("accepts a matching Origin when the browser sends no Sec-Fetch-Site (older browsers)", () => {
        expect(check({ secFetchSite: null }).ok).toBe(true);
    });
});
