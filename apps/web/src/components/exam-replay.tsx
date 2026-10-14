"use client";

import { replaySchema } from "@aura/contracts/api/exams";
import { applyDelta } from "@aura/contracts/text-delta";
import { useCallback, useMemo, useState } from "react";
import { apiGet } from "../lib/api.ts";
import { showInstant } from "../lib/contest-time.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

// The replay of one answer: drag the slider to see the text as it was at each save, with the sitting's events
// beside it. It shows what happened; it decides nothing.
export function ExamReplay(props: {
    examId: string;
    sessionId: string;
    label: string;
    fromSeq: number;
}) {
    const load = useCallback(
        () =>
            apiGet(
                `/exams/${props.examId}/replay/${props.sessionId}/${props.label}?from_seq=${props.fromSeq}`,
                replaySchema,
            ),
        [props.examId, props.sessionId, props.label, props.fromSeq],
    );
    const { data, error } = useLoad(load);
    const [index, setIndex] = useState<number | null>(null);
    // Every text of the page, built once: at most 2,001 of them (the server's page size plus the base).
    const texts = useMemo(() => {
        if (data === null) return [];
        const all = [data.base];
        for (const step of data.steps) all.push(applyDelta(all[all.length - 1] ?? "", step));
        return all;
    }, [data]);
    if (error !== "") return <Notice text="There is no replay here." bad />;
    if (data === null) return <h1 className="text-2xl font-semibold">Replay</h1>;
    const at = Math.min(index ?? texts.length - 1, texts.length - 1);
    const when = at === 0 ? null : data.steps[at - 1]?.at;
    return (
        <>
            <h1 className="text-2xl font-semibold">Replay of problem {props.label}</h1>
            <Section
                id="scrub"
                title={`Save ${data.base_seq + at}${when ? `, ${showInstant(when)}` : ""}`}
            >
                <label className="block">
                    Move through the saves
                    <input
                        type="range"
                        className="block w-full"
                        min={0}
                        max={texts.length - 1}
                        value={at}
                        onChange={(e) => setIndex(Number(e.target.value))}
                    />
                </label>
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded border p-3">
                    {texts[at]}
                </pre>
                {data.next_from_seq !== null && (
                    <p>
                        <a
                            className="text-accent underline"
                            href={`?from_seq=${data.next_from_seq}`}
                        >
                            Later saves
                        </a>
                    </p>
                )}
            </Section>
            <Events events={data.events} />
        </>
    );
}

function Events({ events }: { events: ReturnType<typeof replaySchema.parse>["events"] }) {
    return (
        <Section id="events" title="What happened in the sitting">
            {events.length === 0 && <p>No events were recorded.</p>}
            <ul>
                {events
                    .map((e, n) => ({ ...e, n }))
                    .map((e) => (
                        <li key={e.n}>
                            {showInstant(e.at)}: {e.kind.replaceAll("_", " ")}
                        </li>
                    ))}
            </ul>
        </Section>
    );
}
