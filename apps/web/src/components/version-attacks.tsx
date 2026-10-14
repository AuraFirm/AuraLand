"use client";

import { attackSchema, attacksResponseSchema } from "@aura/contracts/api/attacks";
import { type FormEvent, useCallback, useState } from "react";
import { apiGet, apiSend, messageOf } from "../lib/api.ts";
import { button, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

const ATTACKABLE = ["in_review", "validating", "validated", "released"];

// Human attacks on a version: people other than its author try to pass it without solving it and
// record whether it held. The method is shown as plain text, never as HTML, because it describes an
// attack and may contain anything.
export function VersionAttacks(props: {
    versionId: string;
    state: string;
    canAttack: boolean;
    own: boolean;
}) {
    const load = useCallback(
        () => apiGet(`/task-versions/${props.versionId}/attacks`, attacksResponseSchema),
        [props.versionId],
    );
    const { data, error, reload } = useLoad(load);
    const attacks = data?.attacks ?? [];
    return (
        <Section id="attacks" title="Human attacks">
            {error !== "" && <Notice text={error} bad />}
            {data !== null && attacks.length === 0 && (
                <Notice text="Nobody has tried to game this version yet." />
            )}
            <ul className="mb-4 flex flex-col gap-3">
                {attacks.map((attack) => (
                    <li key={attack.id} className="border-b border-line pb-2">
                        <p className="font-semibold">
                            {attack.outcome === "held" ? "It held" : "It was gamed"}
                        </p>
                        <p className="whitespace-pre-wrap break-words">{attack.method}</p>
                        <p className="text-sm text-muted">{attack.created_at.slice(0, 16)}</p>
                    </li>
                ))}
            </ul>
            {props.canAttack && !props.own && ATTACKABLE.includes(props.state) && (
                <AttackForm versionId={props.versionId} onRecorded={reload} />
            )}
        </Section>
    );
}

function AttackForm({ versionId, onRecorded }: { versionId: string; onRecorded: () => void }) {
    const [outcome, setOutcome] = useState("held");
    const [method, setMethod] = useState("");
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        try {
            await apiSend(`/task-versions/${versionId}/attacks`, attackSchema, {
                method: "POST",
                body: { outcome, method },
            });
            setMethod("");
            setFailed(false);
            setMessage("Finding recorded.");
            onRecorded();
        } catch (problem) {
            setFailed(true);
            setMessage(messageOf(problem));
        }
    };
    return (
        <form onSubmit={submit} className="flex flex-col gap-2">
            <label htmlFor="attack-outcome">What happened when you tried to game it?</label>
            <select
                id="attack-outcome"
                className={input}
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
            >
                <option value="held">It held: I could not pass without solving it</option>
                <option value="gamed">It was gamed: I passed without solving it</option>
            </select>
            <label htmlFor="attack-method">
                What did you try? (plain text, up to 4000 characters)
            </label>
            <textarea
                id="attack-method"
                className={`${input} min-h-24`}
                required
                maxLength={4000}
                value={method}
                onChange={(e) => setMethod(e.target.value)}
            />
            <button type="submit" className={button}>
                Record finding
            </button>
            {message !== "" && <Notice text={message} bad={failed} />}
        </form>
    );
}
