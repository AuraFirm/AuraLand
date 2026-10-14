"use client";

import {
    type SubmissionItem,
    submissionSchema,
    submissionsResponseSchema,
} from "@aura/contracts/api/submissions";
import { judgeLanguageSchema } from "@aura/contracts/judging";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { apiGet, apiSend, messageOf } from "../lib/api.ts";
import { button, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";
import { SubmissionResult } from "./submission-result.tsx";

// How often the page asks whether a submission has been judged. Judging takes seconds; a push channel
// (server-sent events) comes later, so for now the page asks politely.
const POLL_MS = 2_000;

const SKELETON: Record<string, string> = {
    cpp: "#include <iostream>\n\nint main() {\n    return 0;\n}\n",
    python3: "def main():\n    pass\n\n\nmain()\n",
};

// Submit code to a released version, watch it being judged, and see earlier submissions.
export function SubmitPanel({
    versionId,
    languages,
    submitPath = `/task-versions/${versionId}/submissions`,
}: {
    versionId: string;
    languages: readonly string[];
    // Where a submission is posted. Practice-bank problems have their own address for people who are not
    // in the task's organization.
    submitPath?: string;
}) {
    const [current, setCurrent] = useState<string | null>(null);
    const loadMine = useCallback(
        () =>
            apiGet(`/submissions?task_version_id=${versionId}&limit=10`, submissionsResponseSchema),
        [versionId],
    );
    const mine = useLoad(loadMine);
    const supported = languages.filter(
        (language) => judgeLanguageSchema.safeParse(language).success,
    );
    return (
        <Section id="submit" title="Submit a solution">
            {supported.length === 0 ? (
                <Notice text="This task has no language the judge can run yet." />
            ) : (
                <SubmitForm
                    submitPath={submitPath}
                    languages={supported}
                    onSubmitted={(id) => {
                        setCurrent(id);
                        mine.reload();
                    }}
                />
            )}
            {current !== null && <Watching id={current} onSettled={mine.reload} />}
            <Earlier items={mine.data?.items ?? []} />
        </Section>
    );
}

function SubmitForm({
    submitPath,
    languages,
    onSubmitted,
}: {
    submitPath: string;
    languages: readonly string[];
    onSubmitted: (id: string) => void;
}) {
    const [language, setLanguage] = useState(languages[0] ?? "cpp");
    const [source, setSource] = useState(SKELETON[language] ?? "");
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        try {
            const made = await apiSend(submitPath, submissionSchema, {
                method: "POST",
                body: { language, source },
            });
            setFailed(false);
            setMessage("Submitted. Waiting for the judge…");
            onSubmitted(made.id);
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };
    const choose = (name: string) => {
        setLanguage(name);
        setSource(SKELETON[name] ?? "");
    };

    return (
        <form onSubmit={submit} className="flex flex-col gap-2">
            <label htmlFor="submit-language">Language</label>
            <select
                id="submit-language"
                className={input}
                value={language}
                onChange={(e) => choose(e.target.value)}
            >
                {languages.map((name) => (
                    <option key={name} value={name}>
                        {name}
                    </option>
                ))}
            </select>
            <label htmlFor="submit-source">Source code</label>
            <textarea
                id="submit-source"
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

// Follows one submission until it is judged or fails, then shows the result.
function Watching({ id, onSettled }: { id: string; onSettled: () => void }) {
    const [item, setItem] = useState<SubmissionItem | null>(null);
    useEffect(() => {
        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const look = async () => {
            try {
                const latest = await apiGet(`/submissions/${id}`, submissionSchema);
                if (!live) return;
                setItem(latest);
                if (latest.state === "queued" || latest.state === "judging") {
                    timer = setTimeout(look, POLL_MS);
                } else {
                    onSettled();
                }
            } catch {
                // A failed look is retried; the person sees the last known state meanwhile.
                if (live) timer = setTimeout(look, POLL_MS * 2);
            }
        };
        void look();
        return () => {
            live = false;
            if (timer !== undefined) clearTimeout(timer);
        };
    }, [id, onSettled]);
    return item === null ? null : <SubmissionResult item={item} />;
}

function Earlier({ items }: { items: readonly SubmissionItem[] }) {
    if (items.length === 0) return null;
    return (
        <div className="mt-4">
            <h3 className="font-semibold">Your earlier submissions</h3>
            <ul className="flex flex-col gap-1 text-sm">
                {items.map((item) => (
                    <li key={item.id}>
                        {new Date(item.created_at).toLocaleString()} · {item.language} ·{" "}
                        {item.state === "judged"
                            ? `${item.verdict} (${item.score} points)`
                            : item.state.replace("_", " ")}
                    </li>
                ))}
            </ul>
        </div>
    );
}
