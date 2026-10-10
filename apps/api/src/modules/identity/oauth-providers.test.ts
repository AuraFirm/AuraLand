// Goal: the GitHub and Google adapters build correct authorization URLs (PKCE, exact redirect),
// trade a code for the provider's stable id and a provider-verified email only, treat a rejected
// code as a normal failure, and treat outages and nonsense as unavailability.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeOAuthProvider, startFakeOAuthProvider } from "./fake-oauth-provider.ts";
import {
    createGithubProvider,
    createGoogleProvider,
    type OAuthProvider,
    OAuthUnavailableError,
} from "./oauth-providers.ts";

const REDIRECT = "http://localhost:3000/api/v1/auth/oauth/github/callback";
const credentials = { clientId: "client-id", clientSecret: "client-secret" };

let fake: FakeOAuthProvider;
beforeAll(async () => {
    fake = await startFakeOAuthProvider();
});
afterAll(async () => {
    await fake.close();
});

const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const providers: Array<[string, () => OAuthProvider]> = [
    ["github", () => createGithubProvider(credentials, fake.endpoints)],
    ["google", () => createGoogleProvider(credentials, fake.endpoints)],
];

describe.each(providers)("%s adapter", (_name, make) => {
    it("builds an authorization URL with state, S256 challenge and the exact redirect", () => {
        const url = new URL(
            make().authorizationUrl({ state: "st", codeChallenge: "ch", redirectUri: REDIRECT }),
        );
        expect(url.origin + url.pathname).toBe(fake.endpoints.authorizeBase);
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
            response_type: "code",
            client_id: "client-id",
            state: "st",
            code_challenge: "ch",
            code_challenge_method: "S256",
            redirect_uri: REDIRECT,
        });
    });

    it("returns the stable id and the verified email, lowercased", async () => {
        const { verifier, challenge } = pkce();
        const code = fake.authorize(
            { id: "4242", email: "Ada@Example.com", emailVerified: true },
            challenge,
        );
        const result = await make().exchange({
            code,
            codeVerifier: verifier,
            redirectUri: REDIRECT,
        });
        expect(result).toEqual({
            ok: true,
            profile: { providerUserId: "4242", verifiedEmail: "ada@example.com" },
        });
    });

    it("returns no email when the provider has not verified it, or has none", async () => {
        for (const profile of [
            { id: "5", email: "x@example.com", emailVerified: false },
            { id: "6", email: null, emailVerified: false },
        ]) {
            const { verifier, challenge } = pkce();
            const code = fake.authorize(profile, challenge);
            const result = await make().exchange({
                code,
                codeVerifier: verifier,
                redirectUri: REDIRECT,
            });
            expect(result).toMatchObject({ ok: true, profile: { verifiedEmail: null } });
        }
    });
});

describe.each(providers)("%s adapter, token exchange", (_name, make) => {
    it("sends the secret, verifier and redirect to the token endpoint", async () => {
        const { verifier, challenge } = pkce();
        const code = fake.authorize({ id: "7", email: null, emailVerified: false }, challenge);
        await make().exchange({ code, codeVerifier: verifier, redirectUri: REDIRECT });
        expect(fake.tokenRequests.at(-1)).toMatchObject({
            client_id: "client-id",
            client_secret: "client-secret",
            code,
            code_verifier: verifier,
            redirect_uri: REDIRECT,
            grant_type: "authorization_code",
        });
    });

    it("treats a wrong verifier, an unknown code and a reused code as a plain refusal", async () => {
        const { verifier, challenge } = pkce();
        const code = fake.authorize({ id: "8", email: null, emailVerified: false }, challenge);
        const wrong = await make().exchange({
            code,
            codeVerifier: "x".repeat(43),
            redirectUri: REDIRECT,
        });
        expect(wrong).toEqual({ ok: false });
        const again = await make().exchange({
            code,
            codeVerifier: verifier,
            redirectUri: REDIRECT,
        });
        expect(again).toEqual({ ok: false });
        const unknown = await make().exchange({
            code: "nope",
            codeVerifier: verifier,
            redirectUri: REDIRECT,
        });
        expect(unknown).toEqual({ ok: false });
    });

    it("reports an outage as unavailable, never as a refusal", async () => {
        const { verifier } = pkce();
        fake.failNextWith(503);
        await expect(
            make().exchange({ code: "c", codeVerifier: verifier, redirectUri: REDIRECT }),
        ).rejects.toThrow(OAuthUnavailableError);
        const dead = createGithubProvider(credentials, {
            ...fake.endpoints,
            tokenOrigin: "http://127.0.0.1:1",
        });
        await expect(
            dead.exchange({ code: "c", codeVerifier: verifier, redirectUri: REDIRECT }),
        ).rejects.toThrow(OAuthUnavailableError);
    });
});
