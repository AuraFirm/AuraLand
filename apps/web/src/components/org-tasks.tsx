"use client";

import type { OrgItem } from "@aura/contracts/api/orgs";
import { taskSchema, tasksResponseSchema } from "@aura/contracts/api/tasks";
import { type FormEvent, useCallback, useState } from "react";
import { apiGet, apiSend, messageOf } from "../lib/api.ts";
import { canWriteTasks } from "../lib/roles.ts";
import { button, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";
import { type Visibility, VisibilitySelect } from "./visibility-select.tsx";

// The tasks of one organization, newest first, with a form to add one for people who may write.
export function OrgTasks({ org }: { org: OrgItem }) {
    const load = useCallback(
        () => apiGet(`/tasks?org_id=${org.id}`, tasksResponseSchema),
        [org.id],
    );
    const { data, error, reload } = useLoad(load);
    return (
        <Section id="tasks" title="Tasks">
            {error !== "" && <Notice text={error} bad />}
            {data !== null && data.items.length === 0 && <Notice text="No tasks yet." />}
            <ul className="mb-4 flex flex-col gap-2">
                {data?.items.map((task) => (
                    <li
                        key={task.id}
                        className="flex items-center justify-between gap-3 border-b border-line pb-2"
                    >
                        <a className="text-accent underline" href={`/tasks/${task.id}`}>
                            {task.title}
                        </a>
                        <span className="text-sm text-muted">
                            {task.kind} · {task.visibility}
                            {task.released_version !== null
                                ? ` · v${task.released_version.seq} released`
                                : ""}
                        </span>
                    </li>
                ))}
            </ul>
            {canWriteTasks(org.role) && <CreateTask orgId={org.id} onCreated={reload} />}
        </Section>
    );
}

function CreateTask({ orgId, onCreated }: { orgId: string; onCreated: () => void }) {
    const [title, setTitle] = useState("");
    const [slug, setSlug] = useState("");
    const [kind, setKind] = useState<"algorithmic" | "function">("algorithmic");
    const [visibility, setVisibility] = useState<Visibility>("private");
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        try {
            await apiSend("/tasks", taskSchema, {
                method: "POST",
                body: { org_id: orgId, slug, title, kind, visibility },
            });
            setFailed(false);
            setMessage("Task created.");
            setTitle("");
            setSlug("");
            onCreated();
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };

    return (
        <form onSubmit={submit} className="flex flex-col gap-2">
            <h3 className="font-semibold">New task</h3>
            <label htmlFor="task-title">Title</label>
            <input
                id="task-title"
                className={input}
                required
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
            />
            <label htmlFor="task-slug">Address (letters, digits and dashes)</label>
            <input
                id="task-slug"
                className={input}
                required
                minLength={3}
                maxLength={40}
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
            />
            <label htmlFor="task-kind">Kind</label>
            <select
                id="task-kind"
                className={input}
                value={kind}
                onChange={(e) =>
                    setKind(e.target.value === "function" ? "function" : "algorithmic")
                }
            >
                <option value="algorithmic">algorithmic</option>
                <option value="function">function</option>
            </select>
            <VisibilitySelect id="task-visibility" value={visibility} onChange={setVisibility} />
            <button type="submit" className={button}>
                Create task
            </button>
            {message !== "" && <Notice text={message} bad={failed} />}
        </form>
    );
}
