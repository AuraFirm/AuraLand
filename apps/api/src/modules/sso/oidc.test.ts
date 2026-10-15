// Goal: an id_token is believed only when its signature, issuer, audience, expiry, nonce and email all check out. Each test bends
// exactly one thing about a token the fake provider mints with a real key and shows it refused; the good token is accepted.
// Discovery is accepted only when the provider describes itself as the issuer the customer typed.
import { describe, expect, it } from "vitest";
import { createFakeIdp, type FakeIdp } from "./fake-idp.ts";
import { parseDiscovery, verifyIdToken } from "./oidc.ts";

const NONCE = "n-0S6_WzA2Mj";
let idp: FakeIdp;
const verify = async (
    token: string,
    over: { nonce?: string; nowMs?: number; clientId?: string; issuer?: string } = {},
) =>
    verifyIdToken(token, {
        issuer: over.issuer ?? idp.issuer,
        clientId: over.clientId ?? idp.clientId,
        nonce: over.nonce ?? NONCE,
        nowMs: over.nowMs ?? Date.now(),
        keys: idp.jwks ?? { keys: [] },
    });
const good = { sub: "user-1", email: "Ada@Example.com", email_verified: true, nonce: NONCE };

import { beforeAll } from "vitest";

beforeAll(async () => {
    idp = await createFakeIdp();
});

describe("verifyIdToken", () => {
    it("accepts a good token (either allowed algorithm) and lowercases the email", async () => {
        expect(await verify(await idp.mint(good))).toEqual({
            ok: true,
            subject: "user-1",
            email: "ada@example.com",
        });
        expect((await verify(await idp.mint(good, { alg: "RS256" }))).ok).toBe(true);
    });

    it("refuses a token signed by a key the provider never published", async () => {
        expect(await verify(await idp.mint(good, { signWith: "other" }))).toEqual({
            ok: false,
            reason: "signature",
        });
    });

    it("refuses another issuer, another audience, and several audiences without us as the authorized party", async () => {
        expect(
            (await verify(await idp.mint({ ...good, iss: "https://evil.example.com" }))).ok,
        ).toBe(false);
        expect((await verify(await idp.mint({ ...good, aud: "someone-else" }))).ok).toBe(false);
        expect((await verify(await idp.mint({ ...good, aud: [idp.clientId, "other"] }))).ok).toBe(
            false,
        );
        expect(
            (
                await verify(
                    await idp.mint({ ...good, aud: [idp.clientId, "other"], azp: idp.clientId }),
                )
            ).ok,
        ).toBe(true);
    });
});

describe("verifyIdToken, claims", () => {
    it("refuses an expired token, and tolerates only a minute of drift", async () => {
        const now = Math.floor(Date.now() / 1000);
        expect(await verify(await idp.mint({ ...good, exp: now - 120, iat: now - 600 }))).toEqual({
            ok: false,
            reason: "expired",
        });
        expect((await verify(await idp.mint({ ...good, exp: now - 30, iat: now - 600 }))).ok).toBe(
            true,
        );
    });

    it("refuses a wrong or missing nonce (replay of a token from another login)", async () => {
        expect(await verify(await idp.mint({ ...good, nonce: "other" }))).toEqual({
            ok: false,
            reason: "nonce",
        });
        const { nonce: _omitted, ...without } = good;
        expect(await verify(await idp.mint(without))).toEqual({ ok: false, reason: "nonce" });
    });

    it("refuses an unverified or missing email and a missing subject", async () => {
        expect(await verify(await idp.mint({ ...good, email_verified: false }))).toEqual({
            ok: false,
            reason: "email_unverified",
        });
        expect(await verify(await idp.mint({ ...good, email_verified: undefined }))).toEqual({
            ok: false,
            reason: "email_unverified",
        });
        const { email: _e, ...noEmail } = good;
        expect(await verify(await idp.mint(noEmail))).toEqual({
            ok: false,
            reason: "email_unverified",
        });
        expect((await verify(await idp.mint({ ...good, sub: undefined }))).ok).toBe(false);
    });

    it("refuses garbage, an unsigned token and one that says alg none or HS256", async () => {
        expect((await verify("")).ok).toBe(false);
        expect((await verify("a.b.c")).ok).toBe(false);
        const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ ...good, iss: idp.issuer, aud: idp.clientId, exp: 9_999_999_999, iat: 1 })).toString("base64url")}.`;
        expect((await verify(none)).ok).toBe(false);
    });
});

describe("parseDiscovery", () => {
    const doc = (over: Record<string, unknown> = {}) =>
        JSON.stringify({
            issuer: "https://idp.example.com",
            authorization_endpoint: "https://idp.example.com/authorize",
            token_endpoint: "https://idp.example.com/token",
            jwks_uri: "https://idp.example.com/jwks",
            response_types_supported: ["code", "id_token"],
            id_token_signing_alg_values_supported: ["RS256"],
            ...over,
        });
    it("accepts a provider that describes itself as the issuer typed", () => {
        expect(parseDiscovery(doc(), "https://idp.example.com")).toMatchObject({
            tokenEndpoint: "https://idp.example.com/token",
        });
    });
    it("refuses another issuer, a trailing-slash difference, no code flow, no usable algorithm and bad endpoints", () => {
        expect(
            parseDiscovery(doc({ issuer: "https://evil.example.com" }), "https://idp.example.com"),
        ).toBeNull();
        expect(parseDiscovery(doc(), "https://idp.example.com/")).toBeNull();
        expect(
            parseDiscovery(doc({ response_types_supported: ["token"] }), "https://idp.example.com"),
        ).toBeNull();
        expect(
            parseDiscovery(
                doc({ id_token_signing_alg_values_supported: ["HS256", "none"] }),
                "https://idp.example.com",
            ),
        ).toBeNull();
        expect(
            parseDiscovery(
                doc({ token_endpoint: "http://idp.example.com/token" }),
                "https://idp.example.com",
            ),
        ).toBeNull();
        expect(
            parseDiscovery(
                doc({ jwks_uri: "https://169.254.169.254/keys" }),
                "https://idp.example.com",
            ),
        ).toBeNull();
        expect(
            parseDiscovery(
                doc({ authorization_endpoint: "https://idp.example.com:9999/a" }),
                "https://idp.example.com",
            ),
        ).toBeNull();
        expect(parseDiscovery("nope", "https://idp.example.com")).toBeNull();
        expect(parseDiscovery("{}", "https://idp.example.com")).toBeNull();
    });
});
