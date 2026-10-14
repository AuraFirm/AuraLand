"use client";

import { input } from "../lib/styles.ts";
import { type ServerDraft, type SyncStatus, useDraftSync } from "../lib/use-draft-sync.ts";

// The place a candidate writes an answer. Saving is local-first and automatic (see use-draft-sync.ts); this only
// shows it, and says in words whether the work is safe.
const STATUS_TEXT: Readonly<Record<SyncStatus, string>> = {
    loading: "Loading your work…",
    saved: "All changes saved.",
    unsaved: "Not saved to the server yet. It is kept on this computer and will be sent again.",
    over: "The time is over. What was saved is your answer.",
};

export function ExamEditor(props: {
    examId: string;
    label: string;
    languages: readonly string[];
    initial: ServerDraft | null;
}) {
    const { label } = props;
    const sync = useDraftSync(props.examId, label, props.languages[0] ?? "cpp", props.initial);
    const closed = sync.status === "over";
    return (
        <div className="mt-3 flex flex-col gap-2">
            <label htmlFor={`language-${label}`}>Language for problem {label}</label>
            <select
                id={`language-${label}`}
                className={input}
                value={sync.language}
                disabled={closed}
                onChange={(e) => sync.change(sync.text, e.target.value)}
            >
                {props.languages.map((name) => (
                    <option key={name} value={name}>
                        {name}
                    </option>
                ))}
            </select>
            <label htmlFor={`answer-${label}`}>Your answer to problem {label}</label>
            <textarea
                id={`answer-${label}`}
                className={`${input} min-h-60 font-mono`}
                spellCheck={false}
                value={sync.text}
                readOnly={closed}
                onChange={(e) => sync.change(e.target.value, sync.language)}
            />
            <p role="status" aria-live="polite" className="text-sm text-muted">
                {STATUS_TEXT[sync.status]}
            </p>
        </div>
    );
}
