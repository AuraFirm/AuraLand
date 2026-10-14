// Times of a contest are always shown with their zone (docs/kit/09: "18:00 UTC · 00:00 your time"), so
// nobody misses a start because the page picked a zone for them.
export function showInstant(iso: string): string {
    const date = new Date(iso);
    const utc = `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const local = date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    return `${utc} · ${local} your time`;
}

// The browser's datetime-local value is a wall-clock time in the person's zone; the API wants an instant.
export function instantFromLocalInput(value: string): string {
    return new Date(value).toISOString();
}

const STATE_WORDS: Record<string, string> = {
    draft: "Draft",
    scheduled: "Starts soon",
    running: "Running now",
    frozen: "Scoreboard frozen",
    ended: "Ended",
    finalized: "Final",
};
export const stateWords = (state: string): string => STATE_WORDS[state] ?? state;
