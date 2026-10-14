"use client";

import { examResultSchema } from "@aura/contracts/api/exams";
import { useCallback } from "react";
import { apiGet } from "../lib/api.ts";
import { useLoad } from "../lib/use-load.ts";
import { Section } from "./section.tsx";

// A candidate's own result once the grades are released: points per problem, the rubric and the instructor's comment.
export function ExamResult({ examId }: { examId: string }) {
    const load = useCallback(() => apiGet(`/exams/${examId}/result`, examResultSchema), [examId]);
    const { data } = useLoad(load);
    if (data === null) return null;
    return (
        <Section
            id="result"
            title={`Your result: ${data.total_points} of ${data.max_points} points`}
        >
            {data.problems.map((p) => (
                <div key={p.label} className="mb-3 border-b border-line pb-3">
                    <h3 className="font-semibold">
                        Problem {p.label}: {p.total_points} of {p.points}
                    </h3>
                    <p>Judged automatically: {p.auto_points} points</p>
                    <ul>
                        {p.rubric.map((item) => (
                            <li key={item.id}>
                                {item.label}: {item.awarded} of {item.max_points}
                            </li>
                        ))}
                    </ul>
                    {p.comment !== "" && <p>Comment: {p.comment}</p>}
                </div>
            ))}
        </Section>
    );
}
