import { assert } from "@aura/contracts/assert";
import { OAUTH_FLOW_TTL_S } from "./limits.ts";
import { isWellFormedToken, readTokenCookie } from "./rules.ts";

// The cookie that holds the PKCE verifier while the person is away at GitHub or Google. The
// callback must bring it back, which ties the callback to the browser that started the sign-in.

export function oauthCookieName(secure: boolean): string {
    return secure ? "__Host-aura_oauth" : "aura_oauth";
}

function attributes(secure: boolean, maxAgeS: number): string {
    return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
}

export function serializeOauthCookie(verifier: string, secure: boolean): string {
    assert(isWellFormedToken(verifier), "verifier must be 43 url-safe characters");
    return `${oauthCookieName(secure)}=${verifier}; ${attributes(secure, OAUTH_FLOW_TTL_S)}`;
}

export function serializeClearedOauthCookie(secure: boolean): string {
    return `${oauthCookieName(secure)}=; ${attributes(secure, 0)}`;
}

export function parseOauthCookie(header: string | undefined, secure: boolean): string | null {
    return readTokenCookie(header, oauthCookieName(secure));
}
