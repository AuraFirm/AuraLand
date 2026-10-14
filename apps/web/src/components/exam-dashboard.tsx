"use client";

import { examSummarySchema, examsResponseSchema } from "@aura/contracts/api/exams";
import { useCallback } from "react";
import { apiGet } from "../lib/api.ts";
import { showInstant } from "../lib/contest-time.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

// The institution's view of its exams: where each stands, and what waits for a person. Counts only. The attainment
// report is a draft template; outcomes mapping and thresholds need an institution's validation first.
export function ExamDashboard({ orgId }: { orgId: string }) {
    const load = useCallback(
        () => apiGet(`/exams?org_id=${orgId}&limit=30`, examsResponseSchema),
        [orgId],
    );
    const { data, error } = useLoad(load);
    return (
        <>
            <h1 className="text-2xl font-semibold">Exam dashboard</h1>
            {error !== "" && <Notice text="There is nothing to show here." bad />}
            {data?.exams.length === 0 && <Notice text="No exams yet." />}
            {data?.exams.map((exam) => (
                <Section key={exam.id} id={`d-${exam.id}`} title={exam.title}>
                    <p className="text-sm text-muted">
                        {exam.state} · {showInstant(exam.window_start)}
                    </p>
                    <Counts examId={exam.id} />
                    <p className="mt-2">
                        <a className="text-accent underline" href={`/exams/${exam.id}`}>
                            Open the exam
                        </a>{" "}
                        ·{" "}
                        <a
                            className="text-accent underline"
                            href={`/api/v1/exams/${exam.id}/report.csv`}
                        >
                            Attainment report (draft, CSV)
                        </a>
                    </p>
                </Section>
            ))}
        </>
    );
}

function Counts({ examId }: { examId: string }) {
    const load = useCallback(() => apiGet(`/exams/${examId}/summary`, examSummarySchema), [examId]);
    const { data } = useLoad(load);
    if (data === null) return null;
    return (
        <p>
            {data.joined} joined · {data.started} working · {data.submitted} handed in ·{" "}
            {data.expired} ran out of time · {data.flags_open} flags to review · {data.appeals_open}{" "}
            appeals open · {data.oral_waiting} oral answers to score
        </p>
    );
}
