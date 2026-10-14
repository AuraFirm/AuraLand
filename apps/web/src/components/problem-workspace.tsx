"use client";

import { contestProblemViewSchema } from "@aura/contracts/api/contests";
import { submissionSchema, submissionsResponseSchema } from "@aura/contracts/api/submissions";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiGet, apiSend, messageOf } from "../lib/api.ts";
import { button, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Clarifications } from "./clarifications.tsx";
import { SafeHtml } from "./safe-html.tsx";
import { Notice, Section } from "./section.tsx";
import { SubmissionResult } from "./submission-result.tsx";

// The page a contestant works on: the statement, a place to submit, their own submissions and the
// clarifications. Per-test results are never shown while the contest runs (the API hides them).
const POLL_MS = 3_000;
const SKELETON: Record<string, string> = {
    cpp: "#include <iostream>\n\nint main() {\n    return 0;\n}\n",
    c: "#include <stdio.h>\n\nint main(void) {\n    return 0;\n}\n",
    python3: "def main():\n    pass\n\n\nmain()\n",
};

export function ProblemWorkspace({ contestId, label }: { contestId: string; label: string }) {
    const load = useCallback(
        () => apiGet(`/contests/${contestId}/problems/${label}`, contestProblemViewSchema),
        [contestId, label],
    );
    const { data, error } = useLoad(load);
    if (error !== "") {
        return (
            <>
                <h1 className="text-2xl font-semibold">Problem {label}</h1>
                <Notice text="This problem is not available to you. You can read it once you are registered and the contest is running." />
            </>
        );
    }
    if (data === null) return <h1 className="text-2xl font-semibold">Problem {label}</h1>;
    return (
        <>
            <h1 className="text-2xl font-semibold">
                {data.label}. {data.title}
            </h1>
            <p className="text-sm text-muted">
                {data.points} points · {data.time_limit_ms} ms ·{" "}
                {Math.round(data.memory_limit_kib / 1024)} MiB
            </p>
            <SafeHtml html={data.statement_html} label="Problem statement" />
            <SubmitSection contestId={contestId} label={label} languages={data.languages} />
            <Clarifications contestId={contestId} problem={label} />
        </>
    );
}

function SubmitSection({
    contestId,
    label,
    languages,
}: {
    contestId: string;
    label: string;
    languages: readonly string[];
}) {
    const loadMine = useCallback(
        () => apiGet(`/contests/${contestId}/submissions?limit=10`, submissionsResponseSchema),
        [contestId],
    );
    const mine = useLoad(loadMine);
    const waiting = mine.data?.items.some((i) => i.state === "queued" || i.state === "judging");
    const { reload } = mine;
    useEffect(() => {
        if (waiting !== true) return;
        const timer = setInterval(reload, POLL_MS);
        return () => clearInterval(timer);
    }, [waiting, reload]);
    return (
        <Section id="submit" title="Submit a solution">
            <SubmitForm
                contestId={contestId}
                label={label}
                languages={languages}
                onSubmitted={reload}
            />
            {mine.data !== null && mine.data.items.length > 0 && (
                <div className="mt-4">
                    <h3 className="font-semibold">Your submissions in this contest</h3>
                    <ul className="flex flex-col gap-2 text-sm">
                        {mine.data.items.map((item) => (
                            <li key={item.id}>
                                {new Date(item.created_at).toLocaleTimeString()} · {item.language}
                                <SubmissionResult item={item} />
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </Section>
    );
}

function SubmitForm({
    contestId,
    label,
    languages,
    onSubmitted,
}: {
    contestId: string;
    label: string;
    languages: readonly string[];
    onSubmitted: () => void;
}) {
    const [language, setLanguage] = useState(languages[0] ?? "cpp");
    const [source, setSource] = useState(SKELETON[language] ?? "");
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        try {
            await apiSend(
                `/contests/${contestId}/problems/${label}/submissions`,
                submissionSchema,
                {
                    method: "POST",
                    body: { language, source },
                },
            );
            setFailed(false);
            setMessage("Submitted. The judge will answer shortly.");
            onSubmitted();
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };
    return (
        <form onSubmit={submit} className="flex flex-col gap-2">
            <label htmlFor="contest-language">Language</label>
            <select
                id="contest-language"
                className={input}
                value={language}
                onChange={(e) => {
                    setLanguage(e.target.value);
                    setSource(SKELETON[e.target.value] ?? "");
                }}
            >
                {languages.map((name) => (
                    <option key={name} value={name}>
                        {name}
                    </option>
                ))}
            </select>
            <label htmlFor="contest-source">Source code</label>
            <textarea
                id="contest-source"
                className={`${input} min-h-60 font-mono`}
                required
                spellCheck={false}
                maxLength={262144}
                value={source}
                onChange={(e) => setSource(e.target.value)}
            />
            <button type="submit" className={button}>
                Submit
            </button>
            {message !== "" && <Notice text={message} bad={failed} />}
        </form>
    );
}
