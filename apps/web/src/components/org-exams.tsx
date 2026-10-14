"use client";

import { examSchema, examsResponseSchema } from "@aura/contracts/api/exams";
import type { OrgItem } from "@aura/contracts/api/orgs";
import { type FormEvent, useCallback, useState } from "react";
import { apiGet, apiSend, messageOf } from "../lib/api.ts";
import { instantFromLocalInput, showInstant } from "../lib/contest-time.ts";
import { canManageContests } from "../lib/roles.ts";
import { button, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";
import { TextField } from "./text-field.tsx";

// The organization's exams (drafts included for its staff) and a form to set one up. Only owners and
// admins see the form: they are the people the database lets create one.
export function OrgExams({ org }: { org: OrgItem }) {
    const load = useCallback(
        () => apiGet(`/exams?org_id=${org.id}&limit=30`, examsResponseSchema),
        [org.id],
    );
    const { data, error } = useLoad(load);
    return (
        <>
            <Section id="exams" title="Exams">
                {error !== "" && <Notice text={error} bad />}
                {data !== null && data.exams.length === 0 && <Notice text="No exams yet." />}
                <ul className="flex flex-col gap-3">
                    {data?.exams.map((exam) => (
                        <li key={exam.id} className="border-b border-line pb-3">
                            <a className="text-accent underline" href={`/exams/${exam.id}`}>
                                {exam.title}
                            </a>
                            <p className="text-sm text-muted">
                                {exam.state} · {showInstant(exam.window_start)}
                            </p>
                        </li>
                    ))}
                </ul>
            </Section>
            {canManageContests(org.role) && <CreateExam orgId={org.id} />}
        </>
    );
}

interface Values {
    title: string;
    mode: "ai_free" | "ai_allowed_logged";
    minutes: string;
    start: string;
    end: string;
    label: string;
    version: string;
}

function CreateExam({ orgId }: { orgId: string }) {
    const [values, setValues] = useState<Values>({
        title: "",
        mode: "ai_free",
        minutes: "120",
        start: "",
        end: "",
        label: "A",
        version: "",
    });
    const set = (change: Partial<Values>) => setValues((current) => ({ ...current, ...change }));
    const [message, setMessage] = useState("");
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        try {
            const created = await apiSend(`/orgs/${orgId}/exams`, examSchema, {
                method: "POST",
                body: requestFrom(values),
            });
            window.location.assign(`/exams/${created.id}`);
        } catch (error) {
            setMessage(messageOf(error));
        }
    };
    return (
        <Section id="new-exam" title="New exam">
            <form onSubmit={submit} className="flex flex-col gap-2">
                <ExamFields values={values} set={set} />
                <button type="submit" className={button}>
                    Create exam
                </button>
                {message !== "" && <Notice text={message} bad />}
            </form>
        </Section>
    );
}

// One problem to start with, judged entirely by the judge; rubric items and more problems come on the exam's page.
function requestFrom(values: Values) {
    return {
        title: values.title,
        mode: values.mode,
        duration_s: Number(values.minutes) * 60,
        window_start: instantFromLocalInput(values.start),
        window_end: instantFromLocalInput(values.end),
        problems: [
            {
                label: values.label,
                task_version_id: values.version,
                points: 100,
                auto_percent: 100,
                rubric: [],
            },
        ],
    };
}

function ExamFields(props: { values: Values; set: (change: Partial<Values>) => void }) {
    const { values, set } = props;
    return (
        <>
            <TextField
                id="exam-title"
                label="Exam title"
                value={values.title}
                onChange={(title) => set({ title })}
                maxLength={120}
            />
            <label htmlFor="exam-mode">Mode</label>
            <select
                id="exam-mode"
                className={input}
                value={values.mode}
                onChange={(e) =>
                    set({
                        mode:
                            e.target.value === "ai_allowed_logged"
                                ? "ai_allowed_logged"
                                : "ai_free",
                    })
                }
            >
                <option value="ai_free">AI-free</option>
                <option value="ai_allowed_logged">AI allowed, use logged</option>
            </select>
            <TextField
                id="exam-minutes"
                label="Minutes each person has"
                value={values.minutes}
                onChange={(minutes) => set({ minutes })}
                pattern="[0-9]{1,3}"
            />
            <TextField
                id="exam-start"
                label="People may start from (your time zone)"
                type="datetime-local"
                value={values.start}
                onChange={(start) => set({ start })}
            />
            <TextField
                id="exam-end"
                label="and until (your time zone)"
                type="datetime-local"
                value={values.end}
                onChange={(end) => set({ end })}
            />
            <TextField
                id="exam-label"
                label="First problem label"
                value={values.label}
                onChange={(label) => set({ label })}
                pattern="[A-Z][A-Z0-9]{0,2}"
            />
            <TextField
                id="exam-version"
                label="Released task version for it (the id on the version page)"
                value={values.version}
                onChange={(version) => set({ version })}
            />
        </>
    );
}
