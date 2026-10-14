"use client";

import {
    clarificationSchema,
    clarificationsResponseSchema,
} from "@aura/contracts/api/clarifications";
import { type FormEvent, useCallback, useState } from "react";
import { apiGet, apiSend, messageOf } from "../lib/api.ts";
import { button, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

// Questions to the organizers and their answers, as plain text (React escapes it; there is no Markdown or HTML
// path for contestant text). Answers marked public are shown to everyone; the rest only to the asker.
export function Clarifications({
    contestId,
    problem,
}: {
    contestId: string;
    problem: string | null;
}) {
    const load = useCallback(
        () =>
            apiGet(`/contests/${contestId}/clarifications?limit=50`, clarificationsResponseSchema),
        [contestId],
    );
    const { data, reload } = useLoad(load);
    const [question, setQuestion] = useState("");
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const ask = async (event: FormEvent) => {
        event.preventDefault();
        try {
            await apiSend(`/contests/${contestId}/clarifications`, clarificationSchema, {
                method: "POST",
                body: { problem, question },
            });
            setFailed(false);
            setMessage("Question sent to the organizers.");
            setQuestion("");
            reload();
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };
    return (
        <Section id="clarifications" title="Clarifications">
            <form onSubmit={ask} className="flex flex-col gap-2">
                <label htmlFor="clarification-question">Ask the organizers</label>
                <textarea
                    id="clarification-question"
                    className={`${input} min-h-20`}
                    required
                    maxLength={1000}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                />
                <button type="submit" className={button}>
                    Send question
                </button>
                {message !== "" && <Notice text={message} bad={failed} />}
            </form>
            <ul className="mt-4 flex flex-col gap-3">
                {data?.items.map((item) => (
                    <li key={item.id} className="border-b border-line pb-2">
                        <p>
                            <strong>{item.problem ?? "General"}:</strong> {item.question}
                            {item.mine ? " (yours)" : ""}
                        </p>
                        <p className="text-muted">
                            {item.answer === null
                                ? "Not answered yet."
                                : `Answer${item.public ? "" : " (to you only)"}: ${item.answer}`}
                        </p>
                    </li>
                ))}
            </ul>
        </Section>
    );
}
