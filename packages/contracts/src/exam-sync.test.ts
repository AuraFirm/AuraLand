import { describe, expect, it } from "vitest";
import { edit, emptyDraft, nextToSend, onAck, onConflict, onOver } from "./exam-sync.ts";

describe("the candidate's sync rules", () => {
    it("sends the newest edit until it is acknowledged, and nothing for unchanged text", () => {
        let state = emptyDraft("cpp");
        expect(nextToSend(state)).toBeNull();
        state = edit(state, "a");
        state = edit(state, "ab");
        expect(nextToSend(state)).toEqual({ seq: 2, content: "ab", language: "cpp" });
        expect(edit(state, "ab")).toBe(state); // unchanged: no new seq
        state = onAck(state, 1); // a late acknowledgement of an older save
        expect(nextToSend(state)?.seq).toBe(2);
        state = onAck(state, 2);
        expect(nextToSend(state)).toBeNull();
        expect(onAck(state, 1).ackedSeq).toBe(2); // never moves back
    });

    it("continues above the server after a conflict, keeping the current text", () => {
        let state = edit(edit(emptyDraft("cpp"), "a"), "b"); // seq 2
        state = onConflict(state, 7);
        expect(nextToSend(state)).toEqual({ seq: 8, content: "b", language: "cpp" });
        expect(onConflict(edit(emptyDraft("cpp"), "a"), 0).seq).toBe(2);
    });

    it("stops sending when the time is over, and takes no more edits", () => {
        const state = onOver(edit(emptyDraft("cpp"), "a"));
        expect(nextToSend(state)).toBeNull();
        expect(edit(state, "b")).toBe(state);
    });

    it("refuses nonsense acknowledgements", () => {
        expect(() => onAck(emptyDraft("cpp"), -1)).toThrow();
        expect(() => onConflict(emptyDraft("cpp"), 1.5)).toThrow();
    });
});
