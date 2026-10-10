"use client";

import { orgSchema } from "@aura/contracts/api/orgs";
import { versionSchema, versionsResponseSchema } from "@aura/contracts/api/task-versions";
import { taskSchema } from "@aura/contracts/api/tasks";
import { type FormEvent, useCallback, useState } from "react";
import { apiGet, apiSend, messageOf } from "../lib/api.ts";
import { canWriteTasks } from "../lib/roles.ts";
import { button, buttonQuiet, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";
import { type Visibility, VisibilitySelect } from "./visibility-select.tsx";

export function TaskDetail({ taskId }: { taskId: string }) {
    const loadTask = useCallback(() => apiGet(`/tasks/${taskId}`, taskSchema), [taskId]);
    const task = useLoad(loadTask);
    const orgId = task.data?.org_id ?? null;
    const loadOrg = useCallback(
        () => (orgId === null ? Promise.resolve(null) : apiGet(`/orgs/${orgId}`, orgSchema)),
        [orgId],
    );
    const org = useLoad(loadOrg);
    if (task.error !== "") return <Notice text={task.error} bad />;
    if (task.data === null) return <h1 className="text-2xl font-semibold">Task</h1>;
    const writes = org.data !== null && canWriteTasks(org.data.role);
    return (
        <>
            <h1 className="text-2xl font-semibold">{task.data.title}</h1>
            <p className="text-muted">
                {task.data.kind} · {task.data.visibility} · address {task.data.slug}
            </p>
            {writes && <EditTask task={task.data} onSaved={task.reload} />}
            <Versions taskId={taskId} writes={writes} />
            <a className="text-accent underline" href={`/orgs/${task.data.org_id}`}>
                Back to the organization
            </a>
        </>
    );
}

function EditTask({
    task,
    onSaved,
}: {
    task: { id: string; title: string; visibility: string };
    onSaved: () => void;
}) {
    const [title, setTitle] = useState(task.title);
    const [visibility, setVisibility] = useState<Visibility>(
        task.visibility === "org" ? "org" : "private",
    );
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const save = async (event: FormEvent) => {
        event.preventDefault();
        try {
            await apiSend(`/tasks/${task.id}`, taskSchema, {
                method: "PATCH",
                body: { title, visibility },
            });
            setFailed(false);
            setMessage("Saved.");
            onSaved();
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };
    return (
        <Section id="edit-task" title="Details">
            <form onSubmit={save} className="flex flex-col gap-2">
                <label htmlFor="edit-title">Title</label>
                <input
                    id="edit-title"
                    className={input}
                    required
                    maxLength={120}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                />
                <VisibilitySelect
                    id="edit-visibility"
                    value={visibility}
                    onChange={setVisibility}
                />
                <button type="submit" className={button}>
                    Save details
                </button>
                {message !== "" && <Notice text={message} bad={failed} />}
            </form>
        </Section>
    );
}

function Versions({ taskId, writes }: { taskId: string; writes: boolean }) {
    const load = useCallback(
        () => apiGet(`/tasks/${taskId}/versions`, versionsResponseSchema),
        [taskId],
    );
    const { data, error, reload } = useLoad(load);
    const [message, setMessage] = useState("");
    const create = async () => {
        try {
            const made = await apiSend(`/tasks/${taskId}/versions`, versionSchema, {
                method: "POST",
                body: {},
            });
            window.location.assign(`/versions/${made.id}`);
        } catch (failure) {
            setMessage(messageOf(failure));
            reload();
        }
    };
    return (
        <Section id="versions" title="Versions">
            {error !== "" && <Notice text={error} bad />}
            {data !== null && data.items.length === 0 && <Notice text="No versions yet." />}
            <ul className="mb-4 flex flex-col gap-2">
                {data?.items.map((version) => (
                    <li
                        key={version.id}
                        className="flex items-center justify-between gap-3 border-b border-line pb-2"
                    >
                        <a className="text-accent underline" href={`/versions/${version.id}`}>
                            Version {version.seq}
                        </a>
                        <span className="text-sm text-muted">
                            {version.state.replace("_", " ")}
                            {version.waived ? " · released without sandbox validation" : ""}
                        </span>
                    </li>
                ))}
            </ul>
            {writes && (
                <button type="button" className={buttonQuiet} onClick={create}>
                    Start a new version
                </button>
            )}
            {message !== "" && <Notice text={message} bad />}
        </Section>
    );
}
