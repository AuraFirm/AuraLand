import { assert } from "@aura/contracts/assert";
import { OAUTH_FLOW_TTL_S } from "./limits.ts";
import { isWellFormedToken, readTokenCookie } from "./rules.ts";

// The cookie that holds the PKCE verifier while the person is away at the provider. The verifier is
// 256 random bits, not a password; the callback must bring it back, which ties the callback to the
// browser that started the sign-in.

export function flowCookieName(secure: boolean): string {
    return secure ? "__Host-aura_oauth" : "aura_oauth";
}

function attributes(secure: boolean, maxAgeS: number): string {
    return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
}

export function serializeFlowCookie(verifier: string, secure: boolean): string {
    assert(isWellFormedToken(verifier), "verifier must be 43 url-safe characters");
    return `${flowCookieName(secure)}=${verifier}; ${attributes(secure, OAUTH_FLOW_TTL_S)}`;
}

export function serializeClearedFlowCookie(secure: boolean): string {
    return `${flowCookieName(secure)}=; ${attributes(secure, 0)}`;
}

export function parseFlowCookie(header: string | undefined, secure: boolean): string | null {
    return readTokenCookie(header, flowCookieName(secure));
}
