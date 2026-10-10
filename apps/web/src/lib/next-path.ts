// Where to send someone after they sign in. The address comes from the page's own link
// (`/sign-in?next=/invitations/accept`), so it must never be able to point anywhere else. Rather than
// filtering the text we were given, we look it up in a short list of the pages that make sense after
// signing in and return OUR copy of the match. Anything not on the list is ignored, so the result can
// never be a different site, a script address or a path we did not write ourselves (no open redirect).

const AFTER_SIGN_IN: ReadonlyMap<string, string> = new Map([
    ["/account", "/account"],
    ["/orgs", "/orgs"],
    ["/invitations/accept", "/invitations/accept"],
]);

const NEXT_KEY = "aura_next";

export function safeNextPath(candidate: string | null | undefined, fallback: string): string {
    if (candidate === null || candidate === undefined) return fallback;
    return AFTER_SIGN_IN.get(candidate) ?? fallback;
}

// Kept in this tab's session storage across the sign-in screens (and the trip to GitHub or Google).
export function rememberNext(candidate: string | null): void {
    const safe = safeNextPath(candidate, "");
    try {
        if (safe !== "") window.sessionStorage.setItem(NEXT_KEY, safe);
    } catch {
        // Storage can be blocked; the person then lands on the default page, which is fine.
    }
}

export function takeNext(fallback: string): string {
    try {
        const stored = window.sessionStorage.getItem(NEXT_KEY);
        window.sessionStorage.removeItem(NEXT_KEY);
        return safeNextPath(stored, fallback);
    } catch {
        return fallback;
    }
}
