import { exportJWK, generateKeyPair, type JSONWebKeySet, type JWK, SignJWT } from "jose";
import type { Discovery, OidcTransport } from "./oidc.ts";

// An identity provider in memory, for tests: it generates a real signing key, publishes it, and mints real id_tokens whose claims a
// test can bend one at a time. Nothing about it is a network service; it implements the OidcTransport port directly.

export interface IdTokenClaims {
    readonly iss?: string | undefined;
    readonly aud?: string | string[] | undefined;
    readonly sub?: string | undefined;
    readonly email?: string | undefined;
    readonly email_verified?: boolean | undefined;
    readonly nonce?: string | undefined;
    readonly azp?: string | undefined;
    readonly exp?: number | undefined; // seconds
    readonly iat?: number | undefined;
}

export interface FakeIdp extends OidcTransport {
    readonly issuer: string;
    readonly clientId: string;
    readonly discovery: Discovery;
    // Mints a token for the next code exchange; `signWith: "other"` signs with a key the provider never published.
    mint(
        claims: IdTokenClaims,
        options?: { signWith?: "own" | "other"; alg?: "ES256" | "RS256" },
    ): Promise<string>;
    // The id_token the provider will hand back for each code.
    readonly codes: Map<string, string>;
    jwks: JSONWebKeySet | null;
    discoverable: boolean;
    // The time tokens are minted at (milliseconds); tests that run on a fake clock point this at it.
    now: () => number;
}

interface Pair {
    readonly privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
}
interface Keys {
    readonly own: Pair;
    readonly rsa: Pair;
    readonly other: Pair;
}

function signIdToken(
    keys: Keys,
    who: { issuer: string; clientId: string; nowMs: number },
    claims: IdTokenClaims,
    options: { signWith?: "own" | "other"; alg?: "ES256" | "RS256" },
): Promise<string> {
    const now = Math.floor(who.nowMs / 1000);
    const alg = options.alg ?? "ES256";
    const privateKey =
        options.signWith === "other"
            ? keys.other.privateKey
            : alg === "ES256"
              ? keys.own.privateKey
              : keys.rsa.privateKey;
    const kid = options.signWith === "other" ? "own-es" : alg === "ES256" ? "own-es" : "own-rs";
    const { aud, iss, exp, iat, ...rest } = claims;
    // A claim a test leaves out (or sets to undefined) is simply absent from the token.
    const payload: Record<string, unknown> = Object.fromEntries(
        Object.entries(rest).filter(([, value]) => value !== undefined),
    );
    return new SignJWT(payload)
        .setProtectedHeader({ alg, kid })
        .setIssuer(iss ?? who.issuer)
        .setAudience(aud ?? who.clientId)
        .setIssuedAt(iat ?? now)
        .setExpirationTime(exp ?? now + 300)
        .sign(privateKey);
}

export async function createFakeIdp(
    issuer = "https://idp.example.com",
    clientId = "aura-client",
): Promise<FakeIdp> {
    const own = await generateKeyPair("ES256", { extractable: true });
    const rsa = await generateKeyPair("RS256", { extractable: true });
    const other = await generateKeyPair("ES256", { extractable: true });
    const publicJwk = async (
        key: Awaited<ReturnType<typeof generateKeyPair>>["publicKey"],
        kid: string,
        alg: string,
    ): Promise<JWK> => ({
        ...(await exportJWK(key)),
        kid,
        alg,
        use: "sig",
    });
    const keys = [
        await publicJwk(own.publicKey, "own-es", "ES256"),
        await publicJwk(rsa.publicKey, "own-rs", "RS256"),
    ];
    const discovery: Discovery = {
        issuer,
        authorizationEndpoint: `${issuer}/authorize`,
        tokenEndpoint: `${issuer}/token`,
        jwksUri: `${issuer}/jwks`,
    };
    const idp: FakeIdp = {
        issuer,
        clientId,
        discovery,
        codes: new Map(),
        jwks: { keys },
        discoverable: true,
        now: () => Date.now(),
        mint: (claims, options = {}) =>
            signIdToken(
                { own, rsa, other },
                { issuer, clientId, nowMs: idp.now() },
                claims,
                options,
            ),
        async discover(asked) {
            return idp.discoverable && asked === issuer ? discovery : null;
        },
        async fetchJwks(uri) {
            return uri === discovery.jwksUri ? idp.jwks : null;
        },
        async exchangeCode(input) {
            return input.tokenEndpoint === discovery.tokenEndpoint && input.clientId === clientId
                ? (idp.codes.get(input.code) ?? null)
                : null;
        },
    };
    return idp;
}
