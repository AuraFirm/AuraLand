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

const SECOND_MS = 1000;
const MINUTE_S = 60;
const HOUR_S = 3600;
const DAY_S = 86_400;

// A span as a countdown: "2 days 03:04:05" beyond a day, "03:04:05" below. Whole seconds, rounded down, so
// the display never shows a start as later than it is. A negative span reads as zero.
export function countdownText(spanMs: number): string {
    const total = Math.max(0, Math.floor(spanMs / SECOND_MS));
    const days = Math.floor(total / DAY_S);
    const rest = total % DAY_S;
    const pad = (n: number) => String(n).padStart(2, "0");
    const clock = `${pad(Math.floor(rest / HOUR_S))}:${pad(Math.floor((rest % HOUR_S) / MINUTE_S))}:${pad(rest % MINUTE_S)}`;
    if (days === 0) return clock;
    return `${days} ${days === 1 ? "day" : "days"} ${clock}`;
}

// What the countdown says about a contest at `nowMs` (the server's clock), or null once it is over.
export function countdownLabel(
    contest: { starts_at: string; ends_at: string },
    nowMs: number,
): string | null {
    const start = Date.parse(contest.starts_at);
    const end = Date.parse(contest.ends_at);
    if (nowMs < start) return `Starts in ${countdownText(start - nowMs)}`;
    if (nowMs < end) return `Ends in ${countdownText(end - nowMs)}`;
    return null;
}
