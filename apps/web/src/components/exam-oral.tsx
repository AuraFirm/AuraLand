"use client";

import { gradingResponseSchema, oralStaffListSchema } from "@aura/contracts/api/exams";
import { type FormEvent, useCallback, useState } from "react";
import { apiDo, apiGet, detailOf } from "../lib/api.ts";
import { button, buttonQuiet, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

type OralRow = ReturnType<typeof oralStaffListSchema.parse>["rows"][number];

// Oral defence for an exam's staff: choose an answer to ask about, read the questions a model wrote about the
// candidate's own code and the candidate's written answers, and score them. The model writes questions only; the
// score is a person's.
export function ExamOral({ examId }: { examId: string }) {
    const oral = useLoad(
        useCallback(() => apiGet(`/exams/${examId}/oral`, oralStaffListSchema), [examId]),
    );
    const answers = useLoad(
        useCallback(() => apiGet(`/exams/${examId}/grading`, gradingResponseSchema), [examId]),
    );
    const [message, setMessage] = useState("");
    if (oral.error !== "") return <Notice text="There is nothing to show here." bad />;
    const asked = new Set(oral.data?.rows.map((r) => `${r.session_id}:${r.label}`));
    const ask = async (session: string, label: string) => {
        try {
            await apiDo(`/exams/${examId}/oral/${session}/${label}`, { method: "POST" });
            setMessage("Requested. The questions appear here when they are ready.");
            oral.reload();
        } catch (failure) {
            setMessage(detailOf(failure));
        }
    };
    return (
        <>
            <h1 className="text-2xl font-semibold">Oral defence</h1>
            {message !== "" && <Notice text={message} />}
            <Section id="ask" title="Ask about an answer">
                <ul>
                    {answers.data?.rows
                        .filter((r) => r.submission_state !== null)
                        .map((r) => (
                            <li key={`${r.session_id}:${r.label}`} className="mb-1">
                                {r.name}, problem {r.label}{" "}
                                {asked.has(`${r.session_id}:${r.label}`) ? (
                                    <span className="text-muted">(asked)</span>
                                ) : (
                                    <button
                                        type="button"
                                        className={buttonQuiet}
                                        onClick={() => ask(r.session_id, r.label)}
                                    >
                                        Ask questions
                                    </button>
                                )}
                            </li>
                        ))}
                </ul>
            </Section>
            {oral.data?.rows.map((row) => (
                <OralCard
                    key={row.oral_id}
                    examId={examId}
                    row={row}
                    onScored={oral.reload}
                    onAskAgain={ask}
                />
            ))}
        </>
    );
}

function OralCard(props: {
    examId: string;
    row: OralRow;
    onScored: () => void;
    onAskAgain: (session: string, label: string) => void;
}) {
    const { row } = props;
    return (
        <Section
            id={`oral-${row.oral_id}`}
            title={`${row.name}, problem ${row.label}: ${row.state}`}
        >
            {row.state === "failed" && (
                <p>
                    No questions: {row.failure}.{" "}
                    <button
                        type="button"
                        className={buttonQuiet}
                        onClick={() => props.onAskAgain(row.session_id, row.label)}
                    >
                        Ask again
                    </button>
                </p>
            )}
            <ol className="list-decimal pl-6">
                {row.questions?.map((question, index) => (
                    <li key={question} className="mb-2">
                        {question}
                        <p className="text-sm">
                            Answer: {row.answers?.[index] ?? "not answered yet"}
                        </p>
                    </li>
                ))}
            </ol>
            {row.state === "answered" && (
                <ScoreForm examId={props.examId} row={row} onScored={props.onScored} />
            )}
            {row.state === "scored" && (
                <p>
                    Scored {row.score} of 100. {row.score_note}
                </p>
            )}
        </Section>
    );
}

function ScoreForm({
    examId,
    row,
    onScored,
}: {
    examId: string;
    row: OralRow;
    onScored: () => void;
}) {
    const [score, setScore] = useState("");
    const [note, setNote] = useState("");
    const [message, setMessage] = useState("");
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        try {
            await apiDo(`/exams/${examId}/oral/${row.oral_id}/score`, {
                method: "PUT",
                body: { score: Number(score), note },
            });
            onScored();
        } catch (failure) {
            setMessage(detailOf(failure));
        }
    };
    return (
        <form onSubmit={submit} className="mt-2 flex flex-col gap-2">
            <label>
                Your score (0 to 100)
                <input
                    className={`${input} ml-2 w-24`}
                    type="number"
                    min={0}
                    max={100}
                    required
                    value={score}
                    onChange={(e) => setScore(e.target.value)}
                />
            </label>
            <label>
                Note
                <input
                    className={`${input} ml-2 w-96`}
                    maxLength={2000}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                />
            </label>
            <button type="submit" className={button}>
                Save score
            </button>
            {message !== "" && <Notice text={message} bad />}
        </form>
    );
}
