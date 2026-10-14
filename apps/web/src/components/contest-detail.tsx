"use client";

import { contestSchema, registrationResponseSchema } from "@aura/contracts/api/contests";
import { type FormEvent, useCallback, useState } from "react";
import { apiGet, apiSend, messageOf } from "../lib/api.ts";
import { countdownLabel, showInstant, stateWords } from "../lib/contest-time.ts";
import { useServerNow } from "../lib/server-clock.ts";
import { button, buttonQuiet } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";
import { TextField } from "./text-field.tsx";

// One contest: what it is, when it runs, whether you are in, and (for the host's owners and admins) the
// controls to arrange, publish and finalize it. What a person sees is decided by the API.
export function ContestDetail({ contestId }: { contestId: string }) {
    const load = useCallback(() => apiGet(`/contests/${contestId}`, contestSchema), [contestId]);
    const { data, error, reload } = useLoad(load);
    if (error !== "") return <Notice text={error} bad />;
    if (data === null) return <h1 className="text-2xl font-semibold">Contest</h1>;
    return (
        <>
            <h1 className="text-2xl font-semibold">{data.title}</h1>
            <Section id="about" title="About this contest">
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                    <dt className="text-muted">Status</dt>
                    <dd>{stateWords(data.state)}</dd>
                    <dt className="text-muted">Format</dt>
                    <dd>
                        {data.format.toUpperCase()}
                        {data.rated ? ", rated" : ", not rated"}
                    </dd>
                    <dt className="text-muted">Starts</dt>
                    <dd>{showInstant(data.starts_at)}</dd>
                    <dt className="text-muted">Ends</dt>
                    <dd>{showInstant(data.ends_at)}</dd>
                    {data.freeze_at !== null && (
                        <>
                            <dt className="text-muted">Scoreboard freezes</dt>
                            <dd>{showInstant(data.freeze_at)}</dd>
                        </>
                    )}
                    <dt className="text-muted">AI policy</dt>
                    <dd>{data.ai_policy} (stated only: nothing enforces it yet)</dd>
                    <dt className="text-muted">Identity checks</dt>
                    <dd>None</dd>
                </dl>
                <Countdown contest={data} />
                <Problems contest={data} />
            </Section>
            <Registration contest={data} onChanged={reload} />
            {data.can_manage && <Manage contest={data} onChanged={reload} />}
        </>
    );
}

type Contest = ReturnType<typeof contestSchema.parse>;

// Counts by the server's clock, not the browser's. Announced to screen readers only when it is read, not every
// second (a ticking live region would talk over everything else).
function Countdown({ contest }: { contest: Contest }) {
    const now = useServerNow();
    const live =
        contest.state === "scheduled" || contest.state === "running" || contest.state === "frozen";
    if (!live || now === null) return null;
    const label = countdownLabel(contest, now);
    return label === null ? null : <p className="mt-3 text-lg font-semibold">{label}</p>;
}

// Problems are links once the page may show them; the scoreboard is open to everyone while it exists.
function Problems({ contest }: { contest: Contest }) {
    const started = contest.state !== "draft" && contest.state !== "scheduled";
    return (
        <nav aria-label="Contest pages" className="mt-3 flex flex-col gap-2">
            {contest.problems.length > 0 && (
                <ul className="flex flex-wrap gap-3">
                    {contest.problems.map((p) => (
                        <li key={p.label}>
                            {started || contest.can_manage ? (
                                <a
                                    className="text-accent underline"
                                    href={`/arena/contests/${contest.id}/problems/${p.label}`}
                                >
                                    Problem {p.label} · {p.points} points
                                </a>
                            ) : (
                                <span>Problem {p.label}</span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {started && (
                <a
                    className="text-accent underline"
                    href={`/arena/contests/${contest.id}/scoreboard`}
                >
                    Scoreboard
                </a>
            )}
        </nav>
    );
}

function Registration({ contest, onChanged }: { contest: Contest; onChanged: () => void }) {
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const open =
        contest.state === "scheduled" || contest.state === "running" || contest.state === "frozen";
    const register = async () => {
        try {
            const out = await apiSend(
                `/contests/${contest.id}/registrations`,
                registrationResponseSchema,
                { method: "POST" },
            );
            setFailed(false);
            setMessage(
                out.status === "registered"
                    ? "You are registered."
                    : "You were already registered.",
            );
            onChanged();
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };
    return (
        <Section id="registration" title="Taking part">
            {contest.registered === true && <Notice text="You are registered for this contest." />}
            {contest.registered === null && (
                <p>
                    <a
                        className="text-accent underline"
                        href={`/sign-in?next=/arena/contests/${contest.id}`}
                    >
                        Sign in
                    </a>{" "}
                    to register.
                </p>
            )}
            {contest.registered === false && open && !contest.can_manage && (
                <button type="button" className={button} onClick={register}>
                    Register
                </button>
            )}
            {contest.registered === false && !open && <Notice text="Registration is closed." />}
            {contest.can_manage && (
                <Notice text="You organize this contest, so you cannot compete in it." />
            )}
            {message !== "" && <Notice text={message} bad={failed} />}
        </Section>
    );
}

function Manage({ contest, onChanged }: { contest: Contest; onChanged: () => void }) {
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const run = async (path: string, done: string) => {
        try {
            await apiSend(`/contests/${contest.id}/${path}`, contestSchema, { method: "POST" });
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
            <div className="flex flex-wrap gap-2">
                {contest.state === "draft" && (
                    <button
                        type="button"
                        className={button}
                        onClick={() => run("publish", "Published.")}
                    >
                        Publish
                    </button>
                )}
                {contest.state === "ended" && (
                    <button
                        type="button"
                        className={button}
                        onClick={() => run("finalize", "Finalized.")}
                    >
                        Finalize
                    </button>
                )}
            </div>
            {contest.state === "draft" && <AddProblem contest={contest} onChanged={onChanged} />}
            {message !== "" && <Notice text={message} bad={failed} />}
        </Section>
    );
}

function AddProblem({ contest, onChanged }: { contest: Contest; onChanged: () => void }) {
    const [label, setLabel] = useState("");
    const [version, setVersion] = useState("");
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        try {
            await apiSend(`/contests/${contest.id}/problems`, contestSchema, {
                method: "POST",
                body: { label, task_version_id: version },
            });
            setFailed(false);
            setMessage(`Problem ${label} added.`);
            setLabel("");
            setVersion("");
            onChanged();
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };
    const remove = async (target: string) => {
        try {
            await apiSend(`/contests/${contest.id}/problems/${target}`, contestSchema, {
                method: "DELETE",
            });
            onChanged();
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };
    return (
        <form onSubmit={submit} className="mt-4 flex flex-col gap-2">
            <h3 className="font-semibold">Problems</h3>
            <ProblemList problems={contest.problems} onRemove={remove} />
            <TextField
                id="problem-label"
                label="Label (A, B, ... up to three characters)"
                value={label}
                onChange={setLabel}
                pattern="[A-Z][A-Z0-9]{0,2}"
            />
            <TextField
                id="problem-version"
                label="Released task version (the id shown on the version page)"
                value={version}
                onChange={setVersion}
            />
            <button type="submit" className={button}>
                Add problem
            </button>
            {message !== "" && <Notice text={message} bad={failed} />}
        </form>
    );
}

function ProblemList({
    problems,
    onRemove,
}: {
    problems: Contest["problems"];
    onRemove: (label: string) => void;
}) {
    return (
        <ul className="flex flex-col gap-1">
            {problems.map((problem) => (
                <li key={problem.label} className="flex items-center gap-3">
                    <span>
                        {problem.label} · {problem.points} points
                    </span>
                    <button
                        type="button"
                        className={buttonQuiet}
                        onClick={() => onRemove(problem.label)}
                    >
                        Remove {problem.label}
                    </button>
                </li>
            ))}
        </ul>
    );
}
