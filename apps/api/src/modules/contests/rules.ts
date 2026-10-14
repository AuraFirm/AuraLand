import { assert } from "@aura/contracts/assert";
import type { ContestState } from "@aura/contracts/contests";

// Pure rules of a contest's life (Stage 5, ADR 0031). The clock moves a contest through scheduled,
// running, frozen and ended; people publish it and finalize it. The database function advance_contests
// does the same, and a test checks the two against each other on thousands of random contests.

export interface ContestClock {
    readonly state: ContestState;
    readonly startsAtMs: number;
    readonly endsAtMs: number;
    readonly freezeAtMs: number | null;
}

// The state the clock alone brings a contest to by `nowMs`, passing through any state it skipped.
export function stateAt(contest: ContestClock, nowMs: number): ContestState {
    assert(contest.endsAtMs > contest.startsAtMs, "a contest ends after it starts");
    assert(
        contest.freezeAtMs === null ||
            (contest.freezeAtMs > contest.startsAtMs && contest.freezeAtMs < contest.endsAtMs),
        "the freeze falls inside the contest",
    );
    let state = contest.state;
    // Four steps at most: scheduled, running, frozen, ended.
    for (let step = 0; step < 4; step++) {
        const next = nextStep(state, contest, nowMs);
        if (next === null) break;
        state = next;
    }
    return state;
}

function nextStep(state: ContestState, contest: ContestClock, nowMs: number): ContestState | null {
    if (state === "scheduled" && nowMs >= contest.startsAtMs) return "running";
    if (state === "running" && nowMs >= contest.endsAtMs) return "ended";
    if (state === "running" && contest.freezeAtMs !== null && nowMs >= contest.freezeAtMs) {
        return "frozen";
    }
    if (state === "frozen" && nowMs >= contest.endsAtMs) return "ended";
    return null;
}

// Whether submissions are accepted at `nowMs`: the contest is running or frozen and the instant lies
// inside its window. The state alone is not enough, because a stopped worker would leave a finished
// contest "running".
export function acceptsSubmissions(contest: ContestClock, nowMs: number): boolean {
    const live = contest.state === "running" || contest.state === "frozen";
    return live && nowMs >= contest.startsAtMs && nowMs < contest.endsAtMs;
}
