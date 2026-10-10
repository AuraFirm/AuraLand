// Where to send someone after they sign in. The address comes from the page's own link
// (`/sign-in?next=/invitations/accept`), so it must never be able to point anywhere else: only a
// plain path on this site is accepted, otherwise the fallback is used (no open redirect).

const NEXT_KEY = "aura_next";

export function safeNextPath(candidate: string | null | undefined, fallback: string): string {
    if (candidate === null || candidate === undefined) return fallback;
    const plain =
        candidate.startsWith("/") &&
        !candidate.startsWith("//") &&
        !candidate.includes("\\") &&
        !hasControlCharacter(candidate) &&
        candidate.length <= 200;
    return plain ? candidate : fallback;
}

function hasControlCharacter(text: string): boolean {
    for (const character of text) {
        const code = character.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
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
