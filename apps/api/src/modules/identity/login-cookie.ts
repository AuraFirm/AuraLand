import { assert } from "@aura/contracts/assert";
import { LOGIN_LINK_TTL_S } from "./limits.ts";
import { isWellFormedToken, readTokenCookie } from "./rules.ts";

// The cookie that ties a sign-in to the browser that asked for it. It is set when the email is
// requested and must come back with the link or code, so a link opened in another browser (or by
// someone the link was forwarded to) does not sign anyone in. It lives as long as the link does.

export function loginCookieName(secure: boolean): string {
    return secure ? "__Host-aura_login" : "aura_login";
}

function attributes(secure: boolean, maxAgeS: number): string {
    return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
}

export function serializeLoginCookie(binding: string, secure: boolean): string {
    assert(isWellFormedToken(binding), "binding must be 43 url-safe characters");
    return `${loginCookieName(secure)}=${binding}; ${attributes(secure, LOGIN_LINK_TTL_S)}`;
}

export function serializeClearedLoginCookie(secure: boolean): string {
    return `${loginCookieName(secure)}=; ${attributes(secure, 0)}`;
}

export function parseLoginCookie(header: string | undefined, secure: boolean): string | null {
    return readTokenCookie(header, loginCookieName(secure));
}
