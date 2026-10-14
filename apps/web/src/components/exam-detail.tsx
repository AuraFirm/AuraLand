"use client";

import { examSchema, rosterCountSchema } from "@aura/contracts/api/exams";
import { type FormEvent, useCallback, useState } from "react";
import { apiGet, apiSend, detailOf, messageOf } from "../lib/api.ts";
import { showInstant } from "../lib/contest-time.ts";
import { button, buttonQuiet, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { ExamSitting } from "./exam-sitting.tsx";
import { Notice, Section } from "./section.tsx";

type Exam = ReturnType<typeof examSchema.parse>;

// One exam for its staff: what it is, its problems, the roster, and the two moves people make (publish it, release
// its grades). The clock does the rest.
export function ExamDetail({ examId }: { examId: string }) {
    const load = useCallback(() => apiGet(`/exams/${examId}`, examSchema), [examId]);
    const { data, error, reload } = useLoad(load);
    if (error !== "") return <Notice text={error} bad />;
    if (data === null) return <h1 className="text-2xl font-semibold">Exam</h1>;
    return (
        <>
            <h1 className="text-2xl font-semibold">{data.title}</h1>
            <Section id="about" title="About this exam">
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                    <dt className="text-muted">Status</dt>
                    <dd>{data.state}</dd>
                    <dt className="text-muted">Mode</dt>
                    <dd>{data.mode === "ai_free" ? "AI-free" : "AI allowed, use logged"}</dd>
                    <dt className="text-muted">People may start</dt>
                    <dd>
                        {showInstant(data.window_start)} to {showInstant(data.window_end)}
                    </dd>
                    <dt className="text-muted">Each person has</dt>
                    <dd>{Math.round(data.duration_s / 60)} minutes (plus any accommodation)</dd>
                </dl>
                {data.problems !== null && (
                    <ul className="mt-3">
                        {data.problems.map((p) => (
                            <li key={p.label}>
                                Problem {p.label} · {p.points} points · {p.auto_percent}% by the
                                judge
                            </li>
                        ))}
                    </ul>
                )}
            </Section>
            {data.can_manage && <Manage exam={data} onChanged={reload} />}
            {!data.can_manage && <ExamSitting exam={data} />}
        </>
    );
}

function Manage({ exam, onChanged }: { exam: Exam; onChanged: () => void }) {
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const run = async (path: string, done: string) => {
        try {
            await apiSend(`/exams/${exam.id}/${path}`, examSchema, { method: "POST" });
            setFailed(false);
            setMessage(done);
            onChanged();
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };
    return (
        <Section id="manage" title="Organize">
            <p>{exam.roster_size} people on the roster.</p>
            <div className="mt-2 flex flex-wrap gap-2">
                {exam.state === "draft" && (
                    <button
                        type="button"
                        className={button}
                        onClick={() => run("publish", "Published.")}
                    >
                        Publish
                    </button>
                )}
                {exam.state === "closed" && (
                    <button
                        type="button"
                        className={button}
                        onClick={() => run("release-grades", "Grades released.")}
                    >
                        Release grades
                    </button>
                )}
            </div>
            {exam.state !== "draft" && (
                <p className="mt-2">
                    <a className="text-accent underline" href={`/exams/${exam.id}/monitor`}>
                        Monitor and replay
                    </a>{" "}
                    ·{" "}
                    <a className="text-accent underline" href={`/exams/${exam.id}/similarity`}>
                        Similar answers
                    </a>
                </p>
            )}
            {(exam.state === "closed" || exam.state === "released") && (
                <p className="mt-2">
                    <a className="text-accent underline" href={`/exams/${exam.id}/grading`}>
                        Grading and results
                    </a>
                </p>
            )}
            {(exam.state === "draft" || exam.state === "scheduled") && (
                <RosterUpload examId={exam.id} onChanged={onChanged} />
            )}
            {message !== "" && <Notice text={message} bad={failed} />}
        </Section>
    );
}

// Paste or choose a CSV: email,name[,extra_minutes]. The whole file is checked; a bad line names itself.
function RosterUpload({ examId, onChanged }: { examId: string; onChanged: () => void }) {
    const [csv, setCsv] = useState("email,name,extra_minutes\n");
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        try {
            const out = await apiSend(`/exams/${examId}/roster`, rosterCountSchema, {
                method: "PUT",
                body: { csv },
            });
            setFailed(false);
            setMessage(`Roster saved: ${out.people} people.`);
            onChanged();
        } catch (error) {
            setFailed(true);
            setMessage(detailOf(error));
        }
    };
    const choose = async (file: File | undefined) => {
        if (file !== undefined) setCsv(await file.text());
    };
    return (
        <form onSubmit={submit} className="mt-4 flex flex-col gap-2">
            <h3 className="font-semibold">Roster</h3>
            <label htmlFor="roster-file">Choose a CSV file</label>
            <input
                id="roster-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => choose(e.target.files?.[0])}
            />
            <label htmlFor="roster-csv">or paste it (email,name,extra_minutes)</label>
            <textarea
                id="roster-csv"
                className={`${input} min-h-40 font-mono`}
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
            />
            <button type="submit" className={buttonQuiet}>
                Save roster
            </button>
            {message !== "" && <Notice text={message} bad={failed} />}
        </form>
    );
}
