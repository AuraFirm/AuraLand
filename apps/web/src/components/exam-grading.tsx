"use client";

import { answerDetailSchema, gradingResponseSchema } from "@aura/contracts/api/exams";
import { type FormEvent, useCallback, useState } from "react";
import { apiDo, apiGet, detailOf, messageOf } from "../lib/api.ts";
import { button, buttonQuiet, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

type Row = ReturnType<typeof gradingResponseSchema.parse>["rows"][number];

// The grading table for an exam's staff: each answer with the judge's verdict and points, the answer itself on
// request, and the rubric to score while the exam is closed. The judge's share is automatic; only the rubric is
// scored by hand.
export function ExamGrading({ examId }: { examId: string }) {
    const load = useCallback(
        () => apiGet(`/exams/${examId}/grading`, gradingResponseSchema),
        [examId],
    );
    const { data, error, reload } = useLoad(load);
    if (error !== "") return <Notice text="There is nothing to grade here." bad />;
    if (data === null) return <h1 className="text-2xl font-semibold">Grading</h1>;
    return (
        <>
            <h1 className="text-2xl font-semibold">Grading</h1>
            <p>
                <a className="text-accent underline" href={`/api/v1/exams/${examId}/grades.csv`}>
                    Download the grades (CSV)
                </a>
            </p>
            {data.rows.length === 0 && <Notice text="Nobody has started this exam yet." />}
            {data.rows.map((row) => (
                <AnswerCard
                    key={`${row.session_id}:${row.label}`}
                    examId={examId}
                    row={row}
                    onSaved={reload}
                />
            ))}
        </>
    );
}

function AnswerCard({ examId, row, onSaved }: { examId: string; row: Row; onSaved: () => void }) {
    return (
        <Section
            id={`a-${row.session_id}-${row.label}`}
            title={`${row.name} (${row.email}), problem ${row.label}`}
        >
            <p>
                Judge: {row.verdict ?? row.submission_state ?? "no answer"}
                {row.judge_score !== null ? ` · ${row.judge_score}%` : ""} · automatic{" "}
                {row.auto_points} of {row.points} points · rubric {row.rubric_points} · total{" "}
                {row.total_points}
            </p>
            <ShowAnswer examId={examId} row={row} />
            <RubricForm examId={examId} row={row} onSaved={onSaved} />
        </Section>
    );
}

function RubricForm({ examId, row, onSaved }: { examId: string; row: Row; onSaved: () => void }) {
    const [scores, setScores] = useState<Record<string, string>>(
        Object.fromEntries(
            row.rubric.map((item) => [item.id, String(row.rubric_scores[item.id] ?? 0)]),
        ),
    );
    const [comment, setComment] = useState(row.comment);
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const save = async (event: FormEvent) => {
        event.preventDefault();
        try {
            await apiDo(`/exams/${examId}/grades/${row.session_id}/${row.label}`, {
                method: "PUT",
                body: {
                    rubric_scores: Object.fromEntries(
                        Object.entries(scores).map(([k, v]) => [k, Number(v)]),
                    ),
                    comment,
                },
            });
            setFailed(false);
            setMessage("Saved.");
            onSaved();
        } catch (error) {
            setFailed(true);
            setMessage(detailOf(error));
        }
    };
    return (
        <form onSubmit={save} className="mt-3 flex flex-col gap-2">
            {row.rubric.map((item) => (
                <label key={item.id} className="flex items-center gap-2">
                    <span className="w-64">
                        {item.label} (0 to {item.max_points})
                    </span>
                    <input
                        className={`${input} w-24`}
                        type="number"
                        min={0}
                        max={item.max_points}
                        step={1}
                        value={scores[item.id] ?? "0"}
                        onChange={(e) =>
                            setScores((current) => ({ ...current, [item.id]: e.target.value }))
                        }
                    />
                </label>
            ))}
            <label htmlFor={`comment-${row.session_id}-${row.label}`}>
                Comment for the candidate
            </label>
            <textarea
                id={`comment-${row.session_id}-${row.label}`}
                className={`${input} min-h-20`}
                maxLength={2000}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
            />
            <button type="submit" className={button}>
                Save grade
            </button>
            {message !== "" && <Notice text={message} bad={failed} />}
        </form>
    );
}

function ShowAnswer({ examId, row }: { examId: string; row: Row }) {
    const [text, setText] = useState<string | null>(null);
    const [error, setError] = useState("");
    const show = async () => {
        try {
            const detail = await apiGet(
                `/exams/${examId}/answers/${row.session_id}/${row.label}`,
                answerDetailSchema,
            );
            setText(detail.source ?? "(nothing was saved)");
        } catch (failure) {
            setError(messageOf(failure));
        }
    };
    return (
        <div className="mt-2">
            <button type="button" className={buttonQuiet} onClick={show}>
                Show the answer
            </button>
            {error !== "" && <Notice text={error} bad />}
            {text !== null && (
                <pre className="mt-2 overflow-auto rounded border border-line p-2 text-sm">
                    {text}
                </pre>
            )}
        </div>
    );
}
