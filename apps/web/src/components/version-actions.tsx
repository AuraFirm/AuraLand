"use client";

import { type VersionItem, versionSchema } from "@aura/contracts/api/task-versions";
import { type FormEvent, useState } from "react";
import { apiSend, messageOf } from "../lib/api.ts";
import { withStepUp } from "../lib/passkeys.ts";
import { button, buttonDanger, buttonQuiet, input } from "../lib/styles.ts";
import { Notice, Section } from "./section.tsx";

interface Props {
    readonly version: VersionItem;
    readonly writer: boolean;
    readonly reviewer: boolean;
    readonly own: boolean;
    readonly onChanged: () => void;
}

// The steps that move a version along. Releasing and retiring ask for a fresh passkey check.
export function VersionActions(props: Props) {
    const { version, writer, reviewer, own } = props;
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);

    const run = async (path: string, body: unknown, privileged: boolean, done: string) => {
        const call = () =>
            apiSend(`/task-versions/${version.id}/${path}`, versionSchema, {
                method: "POST",
                body,
            });
        try {
            await (privileged ? withStepUp(call) : call());
            setFailed(false);
            setMessage(done);
            props.onChanged();
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };

    const editable = version.state === "draft" || version.state === "uploaded";
    const reviewing = version.state === "in_review" && reviewer && !own;
    return (
        <Section id="actions" title="Next steps">
            {writer && version.state === "uploaded" && (
                <button
                    type="button"
                    className={button}
                    onClick={() => run("submit-review", undefined, false, "Submitted for review.")}
                >
                    Submit for review
                </button>
            )}
            {version.state === "in_review" && own && (
                <Notice text="You made this version, so someone else has to review and release it." />
            )}
            {reviewing && <ReviewForm run={run} />}
            {reviewing && <ReleaseForm run={run} />}
            {reviewer && version.state === "released" && (
                <button
                    type="button"
                    className={buttonDanger}
                    onClick={() => run("retire", undefined, true, "Version retired.")}
                >
                    Retire this version
                </button>
            )}
            {writer && editable && (
                <button
                    type="button"
                    className={`${buttonQuiet} mt-3`}
                    onClick={() => run("abandon", undefined, false, "Version abandoned.")}
                >
                    Abandon this version
                </button>
            )}
            {message !== "" && <Notice text={message} bad={failed} />}
        </Section>
    );
}

type Run = (path: string, body: unknown, privileged: boolean, done: string) => Promise<void>;

function ReviewForm({ run }: { run: Run }) {
    const [comment, setComment] = useState("");
    const send = (outcome: string, done: string) =>
        run("review", { outcome, ...(comment.trim() === "" ? {} : { comment }) }, false, done);
    return (
        <div className="mb-4 flex flex-col gap-2">
            <label htmlFor="review-comment">Review comment (optional)</label>
            <textarea
                id="review-comment"
                className={`${input} min-h-20`}
                maxLength={4000}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    className={button}
                    onClick={() => send("approved", "Approved.")}
                >
                    Approve
                </button>
                <button
                    type="button"
                    className={buttonQuiet}
                    onClick={() => send("changes_requested", "Changes requested.")}
                >
                    Request changes
                </button>
                <button
                    type="button"
                    className={buttonDanger}
                    onClick={() => send("rejected", "Version rejected.")}
                >
                    Reject
                </button>
            </div>
        </div>
    );
}

function ReleaseForm({ run }: { run: Run }) {
    const [reason, setReason] = useState("");
    const submit = (event: FormEvent) => {
        event.preventDefault();
        void run("release", { waiver_reason: reason }, true, "Released.");
    };
    return (
        <form onSubmit={submit} className="flex flex-col gap-2">
            <h3 className="font-semibold">Release without sandbox validation</h3>
            <p className="text-sm text-muted">
                There is no sandbox yet, so a release is a recorded waiver. Approve the version
                first. You will be asked to confirm with your passkey.
            </p>
            <label htmlFor="waiver-reason">
                Why is it safe to release? (at least 10 characters)
            </label>
            <textarea
                id="waiver-reason"
                className={`${input} min-h-20`}
                required
                minLength={10}
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
            />
            <button type="submit" className={button}>
                Release this version
            </button>
        </form>
    );
}
