"use client";

import { oralMineSchema } from "@aura/contracts/api/exams";
import { type FormEvent, useCallback, useState } from "react";
import { apiDo, apiGet, detailOf } from "../lib/api.ts";
import { button, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

type Mine = ReturnType<typeof oralMineSchema.parse>["rows"][number];

// A candidate's written answers to the questions about their own code. Shown only when staff asked; the questions
// came from a model and a person reads the answers.
export function ExamOralAnswers({ examId }: { examId: string }) {
    const { data, reload } = useLoad(
        useCallback(() => apiGet(`/exams/${examId}/oral/mine`, oralMineSchema), [examId]),
    );
    const open = data?.rows.filter((r) => r.state === "ready") ?? [];
    if (open.length === 0) return null;
    return (
        <>
            {open.map((row) => (
                <AnswerForm key={row.oral_id} examId={examId} row={row} onSent={reload} />
            ))}
        </>
    );
}

function AnswerForm({ examId, row, onSent }: { examId: string; row: Mine; onSent: () => void }) {
    const [texts, setTexts] = useState<string[]>(row.questions?.map(() => "") ?? []);
    const [message, setMessage] = useState("");
    const send = async (event: FormEvent) => {
        event.preventDefault();
        try {
            await apiDo(`/exams/${examId}/oral/${row.oral_id}/answers`, {
                method: "PUT",
                body: { answers: texts },
            });
            onSent();
        } catch (failure) {
            setMessage(detailOf(failure));
        }
    };
    return (
        <Section
            id={`oral-${row.oral_id}`}
            title={`Questions about your answer to problem ${row.label}`}
        >
            <p className="mb-2">
                An instructor asked these. They were written by a computer program from your code; a
                person reads your answers and decides what they mean. You can answer once.
            </p>
            <form onSubmit={send} className="flex flex-col gap-3">
                {row.questions?.map((question, index) => (
                    <label key={question}>
                        {question}
                        <textarea
                            className={`${input} mt-1 block w-full`}
                            required
                            maxLength={2000}
                            value={texts[index] ?? ""}
                            onChange={(e) =>
                                setTexts(texts.map((t, i) => (i === index ? e.target.value : t)))
                            }
                        />
                    </label>
                ))}
                <button type="submit" className={button}>
                    Send my answers
                </button>
            </form>
            {message !== "" && <Notice text={message} bad />}
        </Section>
    );
}
