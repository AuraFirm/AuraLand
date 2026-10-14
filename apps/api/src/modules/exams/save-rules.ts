import { assert } from "@aura/contracts/assert";

// The rule of the save function (migration 0046) as a pure function, so a simulation and a database test can
// check the two against each other. The database function is what runs; this is its specification.

export const SAVES_PER_MINUTE_MAX = 60;
export const SAVES_PER_PROBLEM_MAX = 20_000;

export interface ServerView {
    readonly lastSeq: number; // 0 when nothing is stored for this problem
    readonly lastHash: string | null;
    readonly deadlineMs: number;
    readonly sessionStarted: boolean;
    readonly savesLastMinute: number; // across the session
    readonly savesForProblem: number;
}

export interface SaveRequest {
    readonly seq: number;
    readonly hash: string;
    readonly nowMs: number;
}

export type SaveOutcome =
    | { readonly kind: "stored"; readonly ackedSeq: number }
    | { readonly kind: "repeat"; readonly ackedSeq: number }
    | { readonly kind: "conflict"; readonly lastSeq: number }
    | { readonly kind: "over" }
    | { readonly kind: "too_many" };

export function decideSave(view: ServerView, request: SaveRequest): SaveOutcome {
    assert(request.seq >= 1, "a sequence number starts at one");
    if (!view.sessionStarted || request.nowMs >= view.deadlineMs) return { kind: "over" };
    if (request.seq <= view.lastSeq) {
        return request.seq === view.lastSeq && request.hash === view.lastHash
            ? { kind: "repeat", ackedSeq: view.lastSeq }
            : { kind: "conflict", lastSeq: view.lastSeq };
    }
    if (
        view.savesLastMinute >= SAVES_PER_MINUTE_MAX ||
        view.savesForProblem >= SAVES_PER_PROBLEM_MAX
    ) {
        return { kind: "too_many" };
    }
    return { kind: "stored", ackedSeq: request.seq };
}
