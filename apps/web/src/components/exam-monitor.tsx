"use client";

import { examSchema, monitorResponseSchema } from "@aura/contracts/api/exams";
import { useCallback, useEffect } from "react";
import { apiGet } from "../lib/api.ts";
import { showInstant } from "../lib/contest-time.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

// How often the table asks again. Five seconds is fresh enough to see a sitting go quiet and cheap enough that a
// room of staff do not matter next to the candidates' own saves.
const POLL_MS = 5_000;

// The live monitor for an exam's staff: where each person is and counts of signals worth a look. A count is a
// reason to open the replay, never a finding.
export function ExamMonitor({ examId }: { examId: string }) {
    const load = useCallback(
        () => apiGet(`/exams/${examId}/monitor`, monitorResponseSchema),
        [examId],
    );
    const { data, error, reload } = useLoad(load);
    const exam = useLoad(useCallback(() => apiGet(`/exams/${examId}`, examSchema), [examId]));
    useEffect(() => {
        const timer = setInterval(reload, POLL_MS);
        return () => clearInterval(timer);
    }, [reload]);
    if (error !== "") return <Notice text="There is nothing to monitor here." bad />;
    const labels = exam.data?.problems?.map((p) => p.label) ?? [];
    return (
        <>
            <h1 className="text-2xl font-semibold">Monitor</h1>
            <Section id="people" title="People">
                {data !== null && data.rows.length === 0 && <p>Nobody has joined yet.</p>}
                {data !== null && data.rows.length > 0 && (
                    <MonitorTable examId={examId} rows={data.rows} labels={labels} />
                )}
            </Section>
        </>
    );
}

type MonitorRow = ReturnType<typeof monitorResponseSchema.parse>["rows"][number];

function MonitorTable(props: { examId: string; rows: MonitorRow[]; labels: string[] }) {
    const { examId, rows, labels } = props;
    return (
        <table className="w-full text-left text-sm">
            <caption className="sr-only">
                Each person's state, last save and counts of signals
            </caption>
            <thead>
                <tr>
                    {[
                        "Person",
                        "State",
                        "Last save",
                        "Saves",
                        "Left the page",
                        "Pastes",
                        "Offline",
                        "Replay",
                    ].map((h) => (
                        <th key={h} scope="col">
                            {h}
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {rows.map((row) => (
                    <tr key={row.session_id}>
                        <th scope="row">
                            {row.name} ({row.email})
                        </th>
                        <td>{row.state}</td>
                        <td>
                            {row.last_save_at === null ? "never" : showInstant(row.last_save_at)}
                        </td>
                        <td>{row.saves}</td>
                        <td>{row.focus_lost}</td>
                        <td>{row.paste}</td>
                        <td>{row.offline}</td>
                        <td>
                            {labels.map((label) => (
                                <a
                                    key={label}
                                    className="mr-2 text-accent underline"
                                    href={`/exams/${examId}/replay/${row.session_id}/${label}`}
                                >
                                    {label}
                                </a>
                            ))}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
