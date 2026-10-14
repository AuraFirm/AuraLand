import { assert } from "@aura/contracts/assert";

// What raises an integrity flag, and which decisions may follow which. Pure, so a database test can hold the SQL of
// migration 0051 to it. A flag is evidence for a person to weigh: every threshold is a reason to look, none a verdict,
// and nothing here reads or scores the text of an answer for "AI-ness" (kit 08).

export const RULE_VERSION = 1; // changes when a threshold or an explanation changes, so old flags stay explainable
export const FOCUS_LOSSES_MIN = 10;
export const PASTE_CHARS_MIN = 500;
export const SIMILARITY_SCORE_MIN = 0.8;

export type FlagState = "unreviewed" | "clear" | "needs_review" | "confirmed" | "dismissed";
export type Decision = "clear" | "needs_review" | "confirmed" | "dismissed";

// A decision is made once: from unreviewed any of the four, from needs_review any of the three that settle it.
export function decisionAllowed(from: FlagState, to: Decision): boolean {
    if (from === "unreviewed") return true;
    if (from === "needs_review") return to !== "needs_review";
    return false;
}

export interface AppealView {
    readonly appealOpen: boolean;
    readonly flagDecidedBy: string | null;
    readonly reviewer: string;
}
// An appeal is reviewed once, by someone who did not decide the flag. (Whether one can be made at all: the flag is
// confirmed, belongs to the person, and has not been appealed before.)
export function appealReviewAllowed(view: AppealView): "ok" | "same_person" | "not_open" {
    assert(view.reviewer !== "", "a reviewer is named");
    if (!view.appealOpen) return "not_open";
    return view.flagDecidedBy === view.reviewer ? "same_person" : "ok";
}

export interface RaisedFlag {
    readonly sessionId: string;
    readonly label: string;
    readonly kind: "similarity" | "large_paste" | "many_focus_losses";
    readonly evidence: Record<string, number | string>;
    readonly explanation: string; // safe for the candidate to read: names no one else
}

export function focusFlag(sessionId: string, focusLost: number): RaisedFlag | null {
    if (focusLost < FOCUS_LOSSES_MIN) return null;
    return {
        sessionId,
        label: "",
        kind: "many_focus_losses",
        evidence: { count: focusLost, threshold: FOCUS_LOSSES_MIN },
        explanation: `The exam page lost focus ${focusLost} times. This has many harmless causes, such as notifications.`,
    };
}

export function pasteFlag(sessionId: string, charsMax: number): RaisedFlag | null {
    if (charsMax < PASTE_CHARS_MIN) return null;
    return {
        sessionId,
        label: "",
        kind: "large_paste",
        evidence: { chars: charsMax, threshold: PASTE_CHARS_MIN },
        explanation: `A paste of about ${charsMax} characters was recorded. Pasting your own notes is not itself a problem.`,
    };
}

export function similarityFlags(input: {
    label: string;
    score: number;
    shared: number;
    sessionA: string;
    sessionB: string;
}): RaisedFlag[] | null {
    if (input.score < SIMILARITY_SCORE_MIN) return null;
    const explanation = `Your answer to problem ${input.label} closely matches another answer once names, numbers and comments are ignored. Similar answers can be honest.`;
    const flag = (sessionId: string, other: string): RaisedFlag => ({
        sessionId,
        label: input.label,
        kind: "similarity",
        // The other person is named in the evidence, which only staff read.
        evidence: { score: input.score, shared: input.shared, other_session_id: other },
        explanation,
    });
    return [flag(input.sessionA, input.sessionB), flag(input.sessionB, input.sessionA)];
}
