"use client";

import { commentSchema, commentsResponseSchema } from "@aura/contracts/api/comments";
import { type FormEvent, useCallback, useState } from "react";
import { apiGet, apiSend, messageOf } from "../lib/api.ts";
import { button, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { SafeHtml } from "./safe-html.tsx";
import { Notice, Section } from "./section.tsx";

// The discussion about one version, for the people who work on the task. Comments are Markdown; the
// page shows only the safe HTML the API rendered from it. Replies go one level deep.
export function VersionComments({ versionId }: { versionId: string }) {
    const load = useCallback(
        () => apiGet(`/task-versions/${versionId}/comments`, commentsResponseSchema),
        [versionId],
    );
    const { data, error, reload } = useLoad(load);
    const [replyTo, setReplyTo] = useState<string | null>(null);
    const topLevel = data?.comments.filter((comment) => comment.parent_id === null) ?? [];
    const repliesTo = (id: string) => data?.comments.filter((c) => c.parent_id === id) ?? [];
    return (
        <Section id="comments" title="Discussion">
            {error !== "" && <Notice text={error} bad />}
            {data !== null && data.comments.length === 0 && <Notice text="No comments yet." />}
            <ul className="mb-4 flex flex-col gap-3">
                {topLevel.map((comment) => (
                    <li key={comment.id} className="border-b border-line pb-2">
                        <SafeHtml html={comment.body_html} label="Comment" />
                        <p className="text-sm text-muted">{comment.created_at.slice(0, 16)}</p>
                        <ul className="ml-4 mt-2 flex flex-col gap-2">
                            {repliesTo(comment.id).map((reply) => (
                                <li key={reply.id}>
                                    <SafeHtml html={reply.body_html} label="Reply" />
                                </li>
                            ))}
                        </ul>
                        <button
                            type="button"
                            className="mt-1 text-sm text-accent underline"
                            onClick={() => setReplyTo(replyTo === comment.id ? null : comment.id)}
                        >
                            {replyTo === comment.id ? "Cancel reply" : "Reply"}
                        </button>
                        {replyTo === comment.id && (
                            <CommentForm
                                versionId={versionId}
                                parentId={comment.id}
                                label="Your reply"
                                onPosted={() => {
                                    setReplyTo(null);
                                    reload();
                                }}
                            />
                        )}
                    </li>
                ))}
            </ul>
            <CommentForm
                versionId={versionId}
                parentId={null}
                label="Add a comment (Markdown)"
                onPosted={reload}
            />
        </Section>
    );
}

function CommentForm({
    versionId,
    parentId,
    label,
    onPosted,
}: {
    versionId: string;
    parentId: string | null;
    label: string;
    onPosted: () => void;
}) {
    const [text, setText] = useState("");
    const [message, setMessage] = useState("");
    const id = `comment-${parentId ?? "new"}`;
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        try {
            await apiSend(`/task-versions/${versionId}/comments`, commentSchema, {
                method: "POST",
                body: parentId === null ? { body: text } : { body: text, parent_id: parentId },
            });
            setText("");
            setMessage("");
            onPosted();
        } catch (failure) {
            setMessage(messageOf(failure));
        }
    };
    return (
        <form onSubmit={submit} className="mt-2 flex flex-col gap-2">
            <label htmlFor={id}>{label}</label>
            <textarea
                id={id}
                className={input}
                required
                maxLength={8000}
                rows={3}
                value={text}
                onChange={(e) => setText(e.target.value)}
            />
            <button type="submit" className={button}>
                Post
            </button>
            {message !== "" && <Notice text={message} bad />}
        </form>
    );
}
