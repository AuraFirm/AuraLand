import { assert } from "./assert.ts";

// The candidate's side of autosave, as pure rules (Stage 6, slice 4; ADR 0032 and its amendment). The page runs
// these against IndexedDB and the network; the simulation runs the same functions against a faulty network, so
// what is tested is what ships. Nothing here does I/O.
//
// Every save is a full snapshot with a `seq` that only goes up. The client never discards work until the server
// has acknowledged a seq at least as new; after a restart it continues from what it kept.

export interface DraftState {
    readonly seq: number; // the newest local edit
    readonly ackedSeq: number; // the newest seq the server has acknowledged
    readonly content: string;
    readonly language: string;
    // The sitting is over (the server refused at the deadline). Nothing more is sent.
    readonly over: boolean;
}

export const emptyDraft = (language: string, content = ""): DraftState => ({
    seq: 0,
    ackedSeq: 0,
    content,
    language,
    over: false,
});

// A change by the person. Unchanged text is not a new save.
export function edit(
    state: DraftState,
    content: string,
    language: string = state.language,
): DraftState {
    if (state.over || (content === state.content && language === state.language && state.seq > 0)) {
        return state;
    }
    return { ...state, seq: state.seq + 1, content, language };
}

export interface Outgoing {
    readonly seq: number;
    readonly content: string;
    readonly language: string;
}

// What to send now, if anything: the newest edit, when the server has not acknowledged it.
export function nextToSend(state: DraftState): Outgoing | null {
    if (state.over || state.seq === 0 || state.ackedSeq >= state.seq) return null;
    return { seq: state.seq, content: state.content, language: state.language };
}

// The server stored (or already had) a save: `ackedSeq` is the newest it holds. Acknowledgements may arrive late
// or twice; they never move the mark back.
export function onAck(state: DraftState, ackedSeq: number): DraftState {
    assert(Number.isInteger(ackedSeq) && ackedSeq >= 0, "an acknowledgement is a sequence number");
    return ackedSeq > state.ackedSeq ? { ...state, ackedSeq } : state;
}

// The server holds a newer or different save at this seq (another tab, or a late duplicate): carry on above it,
// with the current text, so the newest local state wins.
export function onConflict(state: DraftState, lastSeq: number): DraftState {
    assert(Number.isInteger(lastSeq) && lastSeq >= 0, "a conflict names a sequence number");
    const seq = Math.max(state.seq, lastSeq) + 1;
    return { ...state, seq, ackedSeq: Math.max(state.ackedSeq, Math.min(lastSeq, seq - 1)) };
}

// The server said the time is over. What it holds is the answer.
export const onOver = (state: DraftState): DraftState => ({ ...state, over: true });
