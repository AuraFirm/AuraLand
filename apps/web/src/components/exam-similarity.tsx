"use client";

import {
    answerDetailSchema,
    examSchema,
    similarityResponseSchema,
} from "@aura/contracts/api/exams";
import { Fragment, useCallback, useState } from "react";
import { apiGet } from "../lib/api.ts";
import { button, buttonQuiet } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

type Pair = ReturnType<typeof similarityResponseSchema.parse>["pairs"][number];
type Span = Pair["spans_a"][number];

// Similar answers to one problem, for staff to read. A high score is a reason to look at both answers, and two
// honest answers to a small problem can match; nothing here accuses anyone or reaches the candidates.
export function ExamSimilarity({ examId }: { examId: string }) {
    const exam = useLoad(useCallback(() => apiGet(`/exams/${examId}`, examSchema), [examId]));
    const [label, setLabel] = useState("A");
    const load = useCallback(
        () => apiGet(`/exams/${examId}/similarity?label=${label}`, similarityResponseSchema),
        [examId, label],
    );
    const { data, error } = useLoad(load);
    return (
        <>
            <h1 className="text-2xl font-semibold">Similar answers</h1>
            <p className="flex gap-2">
                {exam.data?.problems?.map((p) => (
                    <button
                        key={p.label}
                        type="button"
                        className={p.label === label ? button : buttonQuiet}
                        aria-pressed={p.label === label}
                        onClick={() => setLabel(p.label)}
                    >
                        Problem {p.label}
                    </button>
                ))}
            </p>
            {error !== "" && <Notice text="There is nothing to compare here." bad />}
            {data !== null && data.pairs.length === 0 && (
                <Notice text={`No pairs among ${data.answers} answers stood out.`} />
            )}
            {data?.pairs.map((pair) => (
                <PairCard
                    key={`${pair.a.session_id}:${pair.b.session_id}`}
                    examId={examId}
                    label={label}
                    pair={pair}
                />
            ))}
        </>
    );
}

function PairCard({ examId, label, pair }: { examId: string; label: string; pair: Pair }) {
    const [shown, setShown] = useState(false);
    return (
        <Section
            id={`pair-${pair.a.session_id}-${pair.b.session_id}`}
            title={`${pair.a.name} and ${pair.b.name}`}
        >
            <p>
                {Math.round(pair.score * 100)}% of the smaller answer's fingerprints match (
                {pair.shared} shared).
            </p>
            <button
                type="button"
                className={`${buttonQuiet} mt-2`}
                onClick={() => setShown(!shown)}
            >
                {shown ? "Hide the answers" : "Show both answers"}
            </button>
            {shown && (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <Answer examId={examId} label={label} who={pair.a} spans={pair.spans_a} />
                    <Answer examId={examId} label={label} who={pair.b} spans={pair.spans_b} />
                </div>
            )}
        </Section>
    );
}

function Answer(props: { examId: string; label: string; who: Pair["a"]; spans: Span[] }) {
    const load = useCallback(
        () =>
            apiGet(
                `/exams/${props.examId}/answers/${props.who.session_id}/${props.label}`,
                answerDetailSchema,
            ),
        [props.examId, props.who.session_id, props.label],
    );
    const { data } = useLoad(load);
    return (
        <div>
            <h3 className="font-semibold">{props.who.name}</h3>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded border p-3">
                {data?.source != null && marked(data.source, props.spans)}
            </pre>
        </div>
    );
}

// The source with the matching ranges wrapped in <mark>; spans are sorted and non-overlapping.
function marked(source: string, spans: Span[]) {
    const parts = [];
    let at = 0;
    for (const span of spans) {
        if (span.start < at || span.end > source.length) continue;
        parts.push(<Fragment key={`t${at}`}>{source.slice(at, span.start)}</Fragment>);
        parts.push(<mark key={`m${span.start}`}>{source.slice(span.start, span.end)}</mark>);
        at = span.end;
    }
    parts.push(<Fragment key="tail">{source.slice(at)}</Fragment>);
    return parts;
}
