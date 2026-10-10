import { emailSchema } from "@aura/contracts/identity";
import { z } from "zod";
import {
    createFixedOriginClient,
    type EgressReply,
    type FixedOriginClient,
} from "../../platform/egress.ts";

// GitHub and Google as OAuth 2.0 authorization-code providers with PKCE (ADR 0016). We build the
// authorization URL and make the token and profile calls ourselves through the egress client, so
// every outbound request goes to a fixed, configured origin with a timeout and a size cap.
// Only the provider's stable user id and a provider-verified email are taken from the profile.

export const PROVIDER_NAMES = ["github", "google"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export class OAuthUnavailableError extends Error {
    override readonly name = "OAuthUnavailableError";
}

export interface ProviderProfile {
    // The provider's own permanent id for the person, as text.
    readonly providerUserId: string;
    // Only an email the provider itself says is verified; otherwise null.
    readonly verifiedEmail: string | null;
}

export type Exchange =
    | { readonly ok: true; readonly profile: ProviderProfile }
    | { readonly ok: false };

export interface OAuthProvider {
    readonly name: ProviderName;
    authorizationUrl(input: {
        readonly state: string;
        readonly codeChallenge: string;
        readonly redirectUri: string;
    }): string;
    // Trades the code for the person's profile. `ok: false` when the provider rejects the code;
    // throws OAuthUnavailableError when the provider cannot be reached or answers nonsense.
    exchange(input: {
        readonly code: string;
        readonly codeVerifier: string;
        readonly redirectUri: string;
    }): Promise<Exchange>;
}

export interface ProviderEndpoints {
    readonly authorizeBase: string; // full URL of the authorization page
    readonly tokenOrigin: string;
    readonly apiOrigin: string;
}

export const GITHUB_ENDPOINTS: ProviderEndpoints = {
    authorizeBase: "https://github.com/login/oauth/authorize",
    tokenOrigin: "https://github.com",
    apiOrigin: "https://api.github.com",
};
export const GOOGLE_ENDPOINTS: ProviderEndpoints = {
    authorizeBase: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenOrigin: "https://oauth2.googleapis.com",
    apiOrigin: "https://openidconnect.googleapis.com",
};

export interface ClientCredentials {
    readonly clientId: string;
    readonly clientSecret: string;
}

const tokenSchema = z.object({ access_token: z.string().min(1).max(4096) });
const errorSchema = z.object({ error: z.string() });

function parseJson(reply: EgressReply): unknown {
    try {
        return JSON.parse(reply.text);
    } catch {
        throw new OAuthUnavailableError("provider sent invalid JSON");
    }
}

// Reads the access token from a token-endpoint reply. Null means the provider rejected the code
// (a client mistake or an expired or reused code); anything else unexpected is an outage.
function tokenOrNull(reply: EgressReply): string | null {
    if (reply.status >= 500) throw new OAuthUnavailableError("provider error");
    const body = parseJson(reply);
    const token = tokenSchema.safeParse(body);
    if (reply.status === 200 && token.success) return token.data.access_token;
    if (errorSchema.safeParse(body).success && reply.status < 500) return null;
    throw new OAuthUnavailableError("unexpected token reply");
}

function verifiedEmailOrNull(email: unknown, verified: boolean): string | null {
    if (!verified) return null;
    const parsed = emailSchema.safeParse(email);
    return parsed.success ? parsed.data : null;
}

function requireOk(reply: EgressReply): unknown {
    if (reply.status !== 200) throw new OAuthUnavailableError("profile request failed");
    return parseJson(reply);
}

async function callProvider<T>(work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (error) {
        if (error instanceof OAuthUnavailableError) throw error;
        throw new OAuthUnavailableError("provider unreachable");
    }
}

function tokenFields(
    credentials: ClientCredentials,
    input: { code: string; codeVerifier: string; redirectUri: string },
): Record<string, string> {
    return {
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code",
    };
}

function authorizeUrl(
    base: string,
    credentials: ClientCredentials,
    input: { state: string; codeChallenge: string; redirectUri: string },
    scope: string,
): string {
    const url = new URL(base);
    url.search = new URLSearchParams({
        response_type: "code",
        client_id: credentials.clientId,
        redirect_uri: input.redirectUri,
        scope,
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: "S256",
    }).toString();
    return url.toString();
}

const githubUserSchema = z.object({ id: z.number().int().positive() });
const githubEmailsSchema = z.array(
    z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }),
);

export function createGithubProvider(
    credentials: ClientCredentials,
    endpoints: ProviderEndpoints = GITHUB_ENDPOINTS,
): OAuthProvider {
    const token: FixedOriginClient = createFixedOriginClient(endpoints.tokenOrigin);
    const api: FixedOriginClient = createFixedOriginClient(endpoints.apiOrigin);
    return {
        name: "github",
        authorizationUrl: (input) =>
            authorizeUrl(endpoints.authorizeBase, credentials, input, "read:user user:email"),
        exchange: (input) =>
            callProvider(async () => {
                const reply = await token.postForm(
                    "/login/oauth/access_token",
                    tokenFields(credentials, input),
                    { accept: "application/json" },
                );
                const accessToken = tokenOrNull(reply);
                if (accessToken === null) return { ok: false };
                const headers = {
                    authorization: `Bearer ${accessToken}`,
                    accept: "application/vnd.github+json",
                    "user-agent": "AuraLand",
                    "x-github-api-version": "2022-11-28",
                };
                const user = githubUserSchema.parse(requireOk(await api.getJson("/user", headers)));
                const emails = githubEmailsSchema.parse(
                    requireOk(await api.getJson("/user/emails", headers)),
                );
                const primary = emails.find((entry) => entry.primary && entry.verified);
                return {
                    ok: true,
                    profile: {
                        providerUserId: String(user.id),
                        verifiedEmail: verifiedEmailOrNull(primary?.email, primary !== undefined),
                    },
                };
            }),
    };
}

const googleUserSchema = z.object({
    sub: z.string().min(1).max(128),
    email: z.string().optional(),
    email_verified: z.boolean().optional(),
});

export function createGoogleProvider(
    credentials: ClientCredentials,
    endpoints: ProviderEndpoints = GOOGLE_ENDPOINTS,
): OAuthProvider {
    const token = createFixedOriginClient(endpoints.tokenOrigin);
    const api = createFixedOriginClient(endpoints.apiOrigin);
    return {
        name: "google",
        authorizationUrl: (input) =>
            authorizeUrl(endpoints.authorizeBase, credentials, input, "openid email"),
        exchange: (input) =>
            callProvider(async () => {
                const reply = await token.postForm("/token", tokenFields(credentials, input), {
                    accept: "application/json",
                });
                const accessToken = tokenOrNull(reply);
                if (accessToken === null) return { ok: false };
                // The token came straight from Google over TLS, so its userinfo answer needs no
                // separate ID-token signature check.
                const user = googleUserSchema.parse(
                    requireOk(
                        await api.getJson("/v1/userinfo", {
                            authorization: `Bearer ${accessToken}`,
                            accept: "application/json",
                        }),
                    ),
                );
                return {
                    ok: true,
                    profile: {
                        providerUserId: user.sub,
                        verifiedEmail: verifiedEmailOrNull(
                            user.email,
                            user.email_verified === true,
                        ),
                    },
                };
            }),
    };
}

// The providers that have credentials configured.
export function createOAuthProviders(settings: {
    readonly github?: ClientCredentials;
    readonly google?: ClientCredentials;
}): ReadonlyMap<ProviderName, OAuthProvider> {
    const providers = new Map<ProviderName, OAuthProvider>();
    if (settings.github !== undefined)
        providers.set("github", createGithubProvider(settings.github));
    if (settings.google !== undefined)
        providers.set("google", createGoogleProvider(settings.google));
    return providers;
}
