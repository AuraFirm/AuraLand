import { createLocalJWKSet, errors, type JSONWebKeySet, jwtVerify } from "jose";
import { z } from "zod";
import { checkWebhookUrl, requestPublic } from "../../platform/webhook-egress.ts";

// OpenID Connect against an identity provider a CUSTOMER chose (Stage 9, ADR 0036): discovery, key set, code exchange and
// id_token checks. Every address is the customer's, so every request goes through the SSRF-safe public client. The id_token is
// believed only after its signature, issuer, audience, expiry and nonce check out; the profile it yields is a subject and a
// verified email, nothing else.

export interface Discovery {
    readonly issuer: string;
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
    readonly jwksUri: string;
}

// The network side as a port, so tests play an identity provider in-process and nothing here ever needs a real one.
export interface OidcTransport {
    discover(issuer: string): Promise<Discovery | null>;
    fetchJwks(jwksUri: string): Promise<JSONWebKeySet | null>;
    exchangeCode(input: {
        readonly tokenEndpoint: string;
        readonly clientId: string;
        readonly clientSecret: string;
        readonly code: string;
        readonly codeVerifier: string;
        readonly redirectUri: string;
    }): Promise<string | null>; // the id_token, or null when the provider refuses
}

const SIGNING_ALGORITHMS = ["RS256", "ES256"] as const;
const DOCUMENT_BYTES_MAX = 256 * 1024;

const discoveryDocument = z.object({
    issuer: z.string(),
    authorization_endpoint: z.string(),
    token_endpoint: z.string(),
    jwks_uri: z.string(),
    response_types_supported: z.array(z.string()).optional(),
    id_token_signing_alg_values_supported: z.array(z.string()).optional(),
});

// The provider's own description of itself, checked against what the customer typed: the issuer must match exactly (a different
// issuer would let one provider speak for another), every endpoint must be an https address the strict policy accepts, and the
// provider must be able to do the code flow with an algorithm we accept.
export function parseDiscovery(text: string, issuer: string): Discovery | null {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return null;
    }
    const doc = discoveryDocument.safeParse(json);
    if (!doc.success || doc.data.issuer !== issuer) return null;
    if (doc.data.response_types_supported?.includes("code") === false) return null;
    const algs = doc.data.id_token_signing_alg_values_supported;
    if (algs !== undefined && !algs.some((alg) => SIGNING_ALGORITHMS.some((ok) => ok === alg)))
        return null;
    const urls = [doc.data.authorization_endpoint, doc.data.token_endpoint, doc.data.jwks_uri];
    if (!urls.every((url) => checkWebhookUrl(url).ok)) return null;
    return {
        issuer,
        authorizationEndpoint: doc.data.authorization_endpoint,
        tokenEndpoint: doc.data.token_endpoint,
        jwksUri: doc.data.jwks_uri,
    };
}

export type IdTokenFailure =
    | "signature"
    | "claims"
    | "expired"
    | "nonce"
    | "email_unverified"
    | "malformed";
export type IdTokenResult =
    | { readonly ok: true; readonly subject: string; readonly email: string }
    | { readonly ok: false; readonly reason: IdTokenFailure };

const CLOCK_TOLERANCE_S = 60; // a little drift between the provider's clock and ours is normal

export async function verifyIdToken(
    idToken: string,
    expected: {
        issuer: string;
        clientId: string;
        nonce: string;
        nowMs: number;
        keys: JSONWebKeySet;
    },
): Promise<IdTokenResult> {
    let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
    try {
        ({ payload } = await jwtVerify(idToken, createLocalJWKSet(expected.keys), {
            issuer: expected.issuer,
            audience: expected.clientId,
            algorithms: [...SIGNING_ALGORITHMS],
            currentDate: new Date(expected.nowMs),
            clockTolerance: CLOCK_TOLERANCE_S,
            requiredClaims: ["exp", "iat", "sub"],
        }));
    } catch (error) {
        if (error instanceof errors.JWTExpired) return { ok: false, reason: "expired" };
        if (error instanceof errors.JWTClaimValidationFailed)
            return { ok: false, reason: "claims" };
        if (error instanceof errors.JWTInvalid || error instanceof errors.JWSInvalid)
            return { ok: false, reason: "malformed" };
        return { ok: false, reason: "signature" };
    }
    // With several audiences the authorized party must be us (OpenID Connect Core 3.1.3.7 rule 4 and 5).
    if (
        Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload["azp"] !== expected.clientId
    )
        return { ok: false, reason: "claims" };
    if (payload["nonce"] !== expected.nonce) return { ok: false, reason: "nonce" };
    const { sub, email } = payload;
    if (typeof sub !== "string" || sub.length === 0 || sub.length > 255)
        return { ok: false, reason: "claims" };
    if (typeof email !== "string" || payload["email_verified"] !== true)
        return { ok: false, reason: "email_unverified" };
    return { ok: true, subject: sub, email: email.toLowerCase() };
}

// The real transport: customer-chosen addresses through the public client, with the documents capped.
export function createPublicOidcTransport(): OidcTransport {
    const options = { responseBytesMax: DOCUMENT_BYTES_MAX };
    return {
        async discover(issuer) {
            const reply = await requestPublic(
                "GET",
                `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
                { accept: "application/json" },
                "",
                options,
            );
            return reply.outcome === "response" && reply.status === 200
                ? parseDiscovery(reply.text, issuer)
                : null;
        },
        async fetchJwks(jwksUri) {
            const reply = await requestPublic(
                "GET",
                jwksUri,
                { accept: "application/json" },
                "",
                options,
            );
            if (reply.outcome !== "response" || reply.status !== 200) return null;
            const parsed = z
                .object({ keys: z.array(z.record(z.string(), z.unknown())).max(50) })
                .safeParse(safeJson(reply.text));
            return parsed.success ? { keys: parsed.data.keys as JSONWebKeySet["keys"] } : null; // tigerlint-allow: no-as-cast -- jose checks each key when it is used
        },
        async exchangeCode(input) {
            const form = new URLSearchParams({
                grant_type: "authorization_code",
                code: input.code,
                redirect_uri: input.redirectUri,
                code_verifier: input.codeVerifier,
                client_id: input.clientId,
                client_secret: input.clientSecret,
            }).toString();
            const reply = await requestPublic(
                "POST",
                input.tokenEndpoint,
                { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
                form,
                options,
            );
            if (reply.outcome !== "response" || reply.status !== 200) return null;
            const parsed = z
                .object({ id_token: z.string().min(1).max(16384) })
                .safeParse(safeJson(reply.text));
            return parsed.success ? parsed.data.id_token : null;
        },
    };
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}
