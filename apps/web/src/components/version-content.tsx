"use client";

import { type VersionItem, versionSchema } from "@aura/contracts/api/task-versions";
import { type FormEvent, useState } from "react";
import { apiSend, messageOf } from "../lib/api.ts";
import { button, input } from "../lib/styles.ts";
import { SafeHtml } from "./safe-html.tsx";
import { Notice, Section } from "./section.tsx";

const EXAMPLE_SPEC = {
    spec_version: 1,
    kind: "algorithmic",
    title: "Sum of two numbers",
    time_limit_ms: 1000,
    memory_limit_kib: 262144,
    output_limit_kib: 1024,
    languages: ["cpp", "python3"],
    scoring: { type: "binary", subtasks: [] },
    tests: [{ id: "001", group: "all", points: 100, is_sample: true }],
    checker: { type: "exact" },
    license: { owner: "Your organization", terms: "internal use" },
    provenance: { author: "Your name", created: "2026-01-01", generated_with_ai: false },
};

// The statement (Markdown, shown rendered) and the spec (JSON). Both are edited as text: the server
// checks them and says when they are not valid.
export function VersionContent({
    version,
    editable,
    onChanged,
}: {
    version: VersionItem;
    editable: boolean;
    onChanged: () => void;
}) {
    return (
        <>
            <Statement version={version} editable={editable} onChanged={onChanged} />
            <Spec version={version} editable={editable} onChanged={onChanged} />
        </>
    );
}

function Statement({
    version,
    editable,
    onChanged,
}: {
    version: VersionItem;
    editable: boolean;
    onChanged: () => void;
}) {
    const [text, setText] = useState(version.statement ?? "");
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const save = async (event: FormEvent) => {
        event.preventDefault();
        try {
            await apiSend(`/task-versions/${version.id}`, versionSchema, {
                method: "PATCH",
                body: { statement: text },
            });
            setFailed(false);
            setMessage("Statement saved.");
            onChanged();
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };
    return (
        <Section id="statement" title="Statement">
            {editable && (
                <form onSubmit={save} className="mb-4 flex flex-col gap-2">
                    <label htmlFor="statement-text">
                        Statement (Markdown; formulas between dollar signs)
                    </label>
                    <textarea
                        id="statement-text"
                        className={`${input} min-h-40 font-mono`}
                        required
                        maxLength={65536}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                    />
                    <button type="submit" className={button}>
                        Save statement
                    </button>
                </form>
            )}
            {message !== "" && <Notice text={message} bad={failed} />}
            {version.statement_html === null || version.statement_html === "" ? (
                <Notice text="No statement yet." />
            ) : (
                <SafeHtml html={version.statement_html} label="Rendered statement" />
            )}
        </Section>
    );
}

function Spec({
    version,
    editable,
    onChanged,
}: {
    version: VersionItem;
    editable: boolean;
    onChanged: () => void;
}) {
    const [text, setText] = useState(JSON.stringify(version.spec ?? EXAMPLE_SPEC, null, 2));
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const save = async (event: FormEvent) => {
        event.preventDefault();
        let spec: unknown;
        try {
            spec = JSON.parse(text);
        } catch {
            setFailed(true);
            setMessage("That is not valid JSON.");
            return;
        }
        try {
            await apiSend(`/task-versions/${version.id}`, versionSchema, {
                method: "PATCH",
                body: { spec },
            });
            setFailed(false);
            setMessage("Spec saved.");
            onChanged();
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };
    return (
        <Section id="spec" title="Spec">
            {editable ? (
                <form onSubmit={save} className="flex flex-col gap-2">
                    <label htmlFor="spec-text">Spec (JSON)</label>
                    <textarea
                        id="spec-text"
                        className={`${input} min-h-60 font-mono`}
                        required
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                    />
                    <button type="submit" className={button}>
                        Save spec
                    </button>
                </form>
            ) : version.spec === null ? (
                <Notice text="No spec yet." />
            ) : (
                <pre className="overflow-x-auto font-mono text-sm">
                    {JSON.stringify(version.spec, null, 2)}
                </pre>
            )}
            {message !== "" && <Notice text={message} bad={failed} />}
        </Section>
    );
}
