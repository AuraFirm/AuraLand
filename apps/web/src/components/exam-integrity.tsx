"use client";

import { integrityListSchema } from "@aura/contracts/api/exams";
import { useCallback, useState } from "react";
import { apiDo, apiGet, detailOf } from "../lib/api.ts";
import { button, buttonQuiet } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

type Flag = ReturnType<typeof integrityListSchema.parse>["flags"][number];

// Integrity review for an exam's staff. A flag is evidence to weigh, never a finding: the rules only point at
// things worth a look. A person decides each flag once; a candidate may appeal a confirmed one, and someone other
// than the decider reviews the appeal.
export function ExamIntegrity({ examId }: { examId: string }) {
    const load = useCallback(
        () => apiGet(`/exams/${examId}/integrity/flags`, integrityListSchema),
        [examId],
    );
    const { data, error, reload } = useLoad(load);
    const [message, setMessage] = useState("");
    const scan = async () => {
        try {
            await apiDo(`/exams/${examId}/integrity/scan`, { method: "POST" });
            setMessage("Checked the rules.");
            reload();
        } catch (failure) {
            setMessage(detailOf(failure));
        }
    };
    if (error !== "") return <Notice text="There is nothing to review here." bad />;
    return (
        <>
            <h1 className="text-2xl font-semibold">Integrity review</h1>
            <p>
                <button type="button" className={button} onClick={scan}>
                    Check the rules now
                </button>
            </p>
            {message !== "" && <Notice text={message} />}
            {data?.flags.length === 0 && <Notice text="Nothing has been flagged." />}
            {data?.flags.map((flag) => (
                <FlagCard key={flag.flag_id} examId={examId} flag={flag} onChanged={reload} />
            ))}
        </>
    );
}

function FlagCard({
    examId,
    flag,
    onChanged,
}: {
    examId: string;
    flag: Flag;
    onChanged: () => void;
}) {
    const [message, setMessage] = useState("");
    const send = async (path: string, body: object) => {
        try {
            await apiDo(`/exams/${examId}/integrity/${path}`, { method: "PUT", body });
            setMessage("");
            onChanged();
        } catch (failure) {
            setMessage(detailOf(failure));
        }
    };
    const open = flag.state === "unreviewed" || flag.state === "needs_review";
    return (
        <Section
            id={`flag-${flag.flag_id}`}
            title={`${flag.name} (${flag.email}): ${flag.kind.replaceAll("_", " ")}`}
        >
            <p>{flag.explanation}</p>
            <p className="text-sm text-muted">
                State: {flag.state}. Rule version {flag.rule_version}. Seen:{" "}
                {JSON.stringify(flag.evidence)}
            </p>
            {open && (
                <p className="mt-2 flex flex-wrap gap-2">
                    {(["clear", "needs_review", "confirmed", "dismissed"] as const)
                        .filter(
                            (state) => !(flag.state === "needs_review" && state === "needs_review"),
                        )
                        .map((state) => (
                            <button
                                key={state}
                                type="button"
                                className={buttonQuiet}
                                onClick={() => send(`flags/${flag.flag_id}`, { state, note: "" })}
                            >
                                Mark {state.replaceAll("_", " ")}
                            </button>
                        ))}
                </p>
            )}
            <AppealRow appeal={flag.appeal} send={send} />
            {message !== "" && <Notice text={message} bad />}
        </Section>
    );
}

function AppealRow(props: {
    appeal: Flag["appeal"];
    send: (path: string, body: object) => Promise<void>;
}) {
    const { appeal, send } = props;
    if (appeal === null) return null;
    return (
        <div className="mt-2">
            <p>
                Appeal ({appeal.state}): {appeal.note}
            </p>
            {appeal.state === "open" && (
                <p className="mt-1 flex gap-2">
                    {(["upheld", "overturned"] as const).map((outcome) => (
                        <button
                            key={outcome}
                            type="button"
                            className={buttonQuiet}
                            onClick={() =>
                                send(`appeals/${appeal.appeal_id}`, { outcome, note: "" })
                            }
                        >
                            Appeal {outcome}
                        </button>
                    ))}
                </p>
            )}
        </div>
    );
}
