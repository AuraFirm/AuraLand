"use client";

import { draftSaveResponseSchema } from "@aura/contracts/api/exams";
import {
    type DraftState,
    edit,
    emptyDraft,
    nextToSend,
    onAck,
    onConflict,
    onOver,
} from "@aura/contracts/exam-sync";
import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiSend } from "./api.ts";
import { loadLocalDraft, saveLocalDraft } from "./exam-drafts-db.ts";
import { reportEdit } from "./exam-telemetry.ts";

// Local-first autosave for one answer (Stage 6, slice 4): every change goes to this computer first and then to the
// server; nothing is forgotten until the server acknowledged it. The decisions are the pure rules of
// @aura/contracts/exam-sync; this file is the wiring to IndexedDB and the network.
const SYNC_EVERY_MS = 2_000;
const SAVE_QUIET_MS = 800; // after the last keystroke

export type SyncStatus = "loading" | "saved" | "unsaved" | "over";
export interface ServerDraft {
    readonly seq: number;
    readonly language: string;
    readonly content: string;
}

// What to start from: what this computer kept and what the server holds, whichever is newer.
export function startingState(
    local: DraftState | null,
    server: ServerDraft | null,
    language: string,
): DraftState {
    const start = local ?? emptyDraft(language);
    if (server !== null && server.seq > start.seq) {
        return {
            seq: server.seq,
            ackedSeq: server.seq,
            content: server.content,
            language: server.language,
            over: false,
        };
    }
    return start;
}

interface Context {
    readonly examId: string;
    readonly label: string;
    readonly state: MutableRefObject<DraftState>;
    readonly busy: MutableRefObject<boolean>;
    readonly persist: (next: DraftState) => Promise<void>;
    readonly setStatus: (status: SyncStatus) => void;
}

// One round of sending: the newest unacknowledged edit, and what the answer means.
async function syncOnce(c: Context): Promise<void> {
    const out = nextToSend(c.state.current);
    if (out === null) {
        if (!c.state.current.over) c.setStatus("saved");
        return;
    }
    if (c.busy.current) return;
    c.busy.current = true;
    try {
        const body = { seq: out.seq, language: out.language, content: out.content };
        const done = await apiSend(
            `/exams/${c.examId}/problems/${c.label}/draft`,
            draftSaveResponseSchema,
            { method: "PUT", body },
        );
        await c.persist(onAck(c.state.current, done.acked_seq));
        c.setStatus(nextToSend(c.state.current) === null ? "saved" : "unsaved");
    } catch (error) {
        await handleFailure(c, error);
    } finally {
        c.busy.current = false;
    }
}

async function handleFailure(c: Context, error: unknown): Promise<void> {
    if (error instanceof ApiError && error.status === 409 && error.detail === "over") {
        await c.persist(onOver(c.state.current));
        c.setStatus("over");
    } else if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.detail?.startsWith("last:")
    ) {
        await c.persist(onConflict(c.state.current, Number(error.detail.slice(5))));
        c.setStatus("unsaved");
    } else {
        c.setStatus("unsaved"); // offline or a hiccup: kept here, tried again
    }
}

export function useDraftSync(
    examId: string,
    label: string,
    language: string,
    server: ServerDraft | null,
) {
    const state = useRef<DraftState>(emptyDraft(language));
    const busy = useRef(false);
    const [text, setText] = useState("");
    const [chosen, setChosen] = useState(language);
    const [status, setStatus] = useState<SyncStatus>("loading");
    const persist = useCallback(
        async (next: DraftState) => {
            state.current = next;
            await saveLocalDraft(examId, label, next).catch(() => undefined);
        },
        [examId, label],
    );
    const sync = useCallback(
        () => syncOnce({ examId, label, state, busy, persist, setStatus }),
        [examId, label, persist],
    );

    useEffect(() => {
        let live = true;
        void loadLocalDraft(examId, label)
            .catch(() => null)
            .then((local) => {
                if (!live) return;
                const start = startingState(local, server, language);
                state.current = start;
                setText(start.content);
                setChosen(start.language);
                setStatus(nextToSend(start) === null ? "saved" : "unsaved");
            });
        return () => {
            live = false;
        };
    }, [examId, label, language, server]);

    useEffect(() => {
        const timer = setInterval(() => void sync(), SYNC_EVERY_MS);
        const online = () => void sync();
        window.addEventListener("online", online);
        return () => {
            clearInterval(timer);
            window.removeEventListener("online", online);
        };
    }, [sync]);

    const change = (content: string, nextLanguage: string) => {
        if (state.current.over) return;
        reportEdit(state.current.content.length, content.length);
        setText(content);
        setChosen(nextLanguage);
        setStatus("unsaved");
        void persist(edit(state.current, content, nextLanguage)).then(() =>
            setTimeout(() => void sync(), SAVE_QUIET_MS),
        );
    };
    return { text, language: chosen, status, change };
}
