"use client";

import { myIntegrityFlagsSchema } from "@aura/contracts/api/exams";
import { type FormEvent, useCallback, useState } from "react";
import { apiDo, apiGet, detailOf } from "../lib/api.ts";
import { button, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

type MyFlag = ReturnType<typeof myIntegrityFlagsSchema.parse>["flags"][number];

// What a candidate reads about an integrity flag that a person confirmed, with the way to appeal it. Nothing
// about other people, and nothing at all until a person has decided.
export function ExamFlags({ examId }: { examId: string }) {
    const load = useCallback(
        () => apiGet(`/exams/${examId}/integrity/mine`, myIntegrityFlagsSchema),
        [examId],
    );
    const { data, reload } = useLoad(load);
    if (data === null || data.flags.length === 0) return null;
    return (
        <>
            {data.flags.map((flag) => (
                <FlagNotice key={flag.flag_id} examId={examId} flag={flag} onAppealed={reload} />
            ))}
        </>
    );
}

function FlagNotice({
    examId,
    flag,
    onAppealed,
}: {
    examId: string;
    flag: MyFlag;
    onAppealed: () => void;
}) {
    const [note, setNote] = useState("");
    const [message, setMessage] = useState("");
    const appeal = async (event: FormEvent) => {
        event.preventDefault();
        try {
            await apiDo(`/exams/${examId}/integrity/flags/${flag.flag_id}/appeal`, {
                method: "POST",
                body: { note },
            });
            onAppealed();
        } catch (failure) {
            setMessage(detailOf(failure));
        }
    };
    return (
        <Section id={`flag-${flag.flag_id}`} title="A concern was recorded about your exam">
            <p>{flag.explanation}</p>
            {flag.appeal_state === null ? (
                <form onSubmit={appeal} className="mt-3 flex flex-col gap-2">
                    <label>
                        Tell us your side. A different person will read it.
                        <textarea
                            className={`${input} mt-1 block w-full`}
                            value={note}
                            maxLength={2000}
                            required
                            onChange={(e) => setNote(e.target.value)}
                        />
                    </label>
                    <button type="submit" className={button}>
                        Appeal
                    </button>
                </form>
            ) : (
                <p className="mt-2">Your appeal: {flag.appeal_state}.</p>
            )}
            {message !== "" && <Notice text={message} bad />}
        </Section>
    );
}
