"use client";

import {
    consentTextSchema,
    type ExamItem,
    examProblemViewSchema,
    examSchema,
    examSessionSchema,
} from "@aura/contracts/api/exams";
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiGet, apiSend, messageOf } from "../lib/api.ts";
import { countdownText, showInstant } from "../lib/contest-time.ts";
import { useServerNow } from "../lib/server-clock.ts";
import { button } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { SafeHtml } from "./safe-html.tsx";
import { Notice, Section } from "./section.tsx";

// The candidate's side of an exam (Stage 6, slice 3): check the machine, read and agree to what is recorded,
// start, and work against the server's clock. Saving answers is the next slice.
export function ExamSitting({ exam }: { exam: ExamItem }) {
    const load = useCallback(async () => {
        try {
            return await apiGet(`/exams/${exam.id}/session`, examSessionSchema);
        } catch (error) {
            if (error instanceof ApiError && error.status === 404) return null;
            throw error;
        }
    }, [exam.id]);
    const { data, error, reload } = useLoad(load);
    const [message, setMessage] = useState("");
    const act = async (path: string) => {
        try {
            await apiSend(`/exams/${exam.id}/${path}`, examSessionSchema, {
                method: "POST",
                ...(path === "consent"
                    ? { body: { text_version: data?.current_consent_text_version ?? 1 } }
                    : {}),
            });
            setMessage("");
            reload();
        } catch (failure) {
            setMessage(messageOf(failure));
        }
    };
    if (error !== "") return <Notice text={error} bad />;
    return (
        <>
            {data === null && <Join exam={exam} onJoin={() => act("join")} />}
            {data?.state === "invited" && <Consent onAgree={() => act("consent")} />}
            {data?.state === "consented" && <Ready exam={exam} onStart={() => act("start")} />}
            {data?.state === "started" && (
                <Working exam={exam} deadlineAt={data.deadline_at ?? ""} />
            )}
            {(data?.state === "submitted" || data?.state === "expired") && (
                <Notice
                    text={
                        data.state === "submitted"
                            ? "You have handed in this exam."
                            : "Your time is over. What you saved is your answer."
                    }
                />
            )}
            {message !== "" && <Notice text={message} bad />}
        </>
    );
}

function Join({ exam, onJoin }: { exam: ExamItem; onJoin: () => void }) {
    return (
        <Section id="join" title="Sit this exam">
            <p>
                People may start from {showInstant(exam.window_start)} until{" "}
                {showInstant(exam.window_end)}, and then have {Math.round(exam.duration_s / 60)}{" "}
                minutes.
            </p>
            <button type="button" className={`${button} mt-3`} onClick={onJoin}>
                Get ready
            </button>
        </Section>
    );
}

function Consent({ onAgree }: { onAgree: () => void }) {
    const load = useCallback(() => apiGet("/exam-consent-text", consentTextSchema), []);
    const { data } = useLoad(load);
    const [agreed, setAgreed] = useState(false);
    return (
        <>
            <SystemCheck />
            <Section id="consent" title="What this exam records">
                {data?.text.split("\n\n").map((paragraph) => (
                    <p key={paragraph} className="mb-2">
                        {paragraph}
                    </p>
                ))}
                <label className="mt-3 flex items-center gap-2">
                    <input
                        type="checkbox"
                        checked={agreed}
                        onChange={(e) => setAgreed(e.target.checked)}
                    />
                    I have read this and I agree
                </label>
                <button
                    type="button"
                    className={`${button} mt-3`}
                    disabled={!agreed}
                    onClick={onAgree}
                >
                    Continue
                </button>
            </Section>
        </>
    );
}

// Four things worth knowing before the clock starts. Each is plain words; none changes anything.
function SystemCheck() {
    const now = useServerNow();
    const [storage, setStorage] = useState<boolean | null>(null);
    const [online, setOnline] = useState(true);
    useEffect(() => {
        setOnline(navigator.onLine);
        const request = indexedDB.open("aura-system-check");
        request.onsuccess = () => {
            request.result.close();
            indexedDB.deleteDatabase("aura-system-check");
            setStorage(true);
        };
        request.onerror = () => setStorage(false);
    }, []);
    const skewS = now === null ? null : Math.round(Math.abs(now - Date.now()) / 1000);
    return (
        <Section id="check" title="Check this computer">
            <ul>
                <li>
                    {online
                        ? "You are online."
                        : "You appear to be offline: reconnect before you start."}
                </li>
                <li>
                    {storage === null
                        ? "Checking that this browser can keep your work safe…"
                        : storage
                          ? "This browser can keep your work safe if the connection drops."
                          : "This browser cannot store drafts; use another browser or window (not private mode)."}
                </li>
                <li>
                    {skewS === null
                        ? "Checking the clock…"
                        : skewS < 120
                          ? "Your clock agrees with ours."
                          : `Your clock is ${skewS} seconds off. The exam uses our clock, not yours.`}
                </li>
            </ul>
        </Section>
    );
}

function Ready({ exam, onStart }: { exam: ExamItem; onStart: () => void }) {
    const now = useServerNow();
    const opensIn = now === null ? null : Date.parse(exam.window_start) - now;
    const open = opensIn !== null && opensIn <= 0 && exam.state === "open";
    return (
        <Section id="ready" title="Ready to start">
            <p>
                You have {Math.round(exam.duration_s / 60)} minutes from the moment you press Start
                (or until the window closes at {showInstant(exam.window_end)}, whichever is first,
                plus any extra time agreed for you).
            </p>
            {opensIn !== null && opensIn > 0 && (
                <p className="mt-2 font-semibold">Opens in {countdownText(opensIn)}</p>
            )}
            <button type="button" className={`${button} mt-3`} disabled={!open} onClick={onStart}>
                Start the exam
            </button>
        </Section>
    );
}

// The timer counts toward the server's deadline by the server's clock. Remaining time is spoken at a few
// moments only, so a screen reader is not talking every second.
const SPOKEN_AT_S = [600, 300, 60];

function Working({ exam, deadlineAt }: { exam: ExamItem; deadlineAt: string }) {
    const now = useServerNow();
    const remainingMs = now === null ? null : Date.parse(deadlineAt) - now;
    const [spoken, setSpoken] = useState("");
    useEffect(() => {
        if (remainingMs === null) return;
        const seconds = Math.floor(remainingMs / 1000);
        if (SPOKEN_AT_S.includes(seconds))
            setSpoken(`${Math.round(seconds / 60)} minute${seconds === 60 ? "" : "s"} left`);
        if (seconds === 0) setSpoken("Time is up");
    }, [remainingMs]);
    return (
        <>
            <Section id="timer" title="Time left">
                <p className="text-2xl font-semibold">
                    {remainingMs === null ? "…" : countdownText(remainingMs)}
                </p>
                <p role="status" aria-live="polite" className="sr-only">
                    {spoken}
                </p>
            </Section>
            <Problems exam={exam} />
        </>
    );
}

function Problems({ exam }: { exam: ExamItem }) {
    const reload = useCallback(() => apiGet(`/exams/${exam.id}`, examSchema), [exam.id]);
    const { data } = useLoad(reload);
    return (
        <>
            {data?.problems?.map((p) => (
                <ProblemStatement
                    key={p.label}
                    examId={exam.id}
                    label={p.label}
                    points={p.points}
                />
            ))}
        </>
    );
}

function ProblemStatement(props: { examId: string; label: string; points: number }) {
    const load = useCallback(
        () => apiGet(`/exams/${props.examId}/problems/${props.label}`, examProblemViewSchema),
        [props.examId, props.label],
    );
    const { data } = useLoad(load);
    if (data === null) return null;
    return (
        <Section
            id={`problem-${props.label}`}
            title={`${props.label}. ${data.title} (${props.points} points)`}
        >
            <p className="mb-2 text-sm text-muted">
                {data.time_limit_ms} ms · {Math.round(data.memory_limit_kib / 1024)} MiB
            </p>
            <SafeHtml html={data.statement_html} label={`Problem ${props.label}`} />
        </Section>
    );
}
