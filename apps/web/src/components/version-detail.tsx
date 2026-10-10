"use client";

import { meResponseSchema } from "@aura/contracts/api/identity";
import { orgSchema } from "@aura/contracts/api/orgs";
import { versionSchema } from "@aura/contracts/api/task-versions";
import { taskSchema } from "@aura/contracts/api/tasks";
import { useCallback } from "react";
import { apiGet } from "../lib/api.ts";
import { canReviewTasks, canWriteTasks } from "../lib/roles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";
import { VersionActions } from "./version-actions.tsx";
import { VersionBundle } from "./version-bundle.tsx";
import { VersionContent } from "./version-content.tsx";

// One version of a task: its statement, spec and bundle while they can be edited, and the steps that
// move it toward release. The controls shown depend on the caller's role and on the version's state;
// the API refuses anything else, so this only keeps the screen honest.
export function VersionDetail({ versionId }: { versionId: string }) {
    const loadVersion = useCallback(
        () => apiGet(`/task-versions/${versionId}`, versionSchema),
        [versionId],
    );
    const version = useLoad(loadVersion);
    const taskId = version.data?.task_id ?? null;
    const loadTask = useCallback(
        () => (taskId === null ? Promise.resolve(null) : apiGet(`/tasks/${taskId}`, taskSchema)),
        [taskId],
    );
    const task = useLoad(loadTask);
    const orgId = task.data?.org_id ?? null;
    const loadOrg = useCallback(
        () => (orgId === null ? Promise.resolve(null) : apiGet(`/orgs/${orgId}`, orgSchema)),
        [orgId],
    );
    const org = useLoad(loadOrg);
    const loadMe = useCallback(() => apiGet("/me", meResponseSchema), []);
    const me = useLoad(loadMe);

    const error = version.error || task.error || org.error || me.error;
    if (error !== "") return <Notice text={error} bad />;
    if (version.data === null || task.data === null || org.data === null || me.data === null) {
        return <h1 className="text-2xl font-semibold">Version</h1>;
    }
    const current = version.data;
    const role = org.data.role;
    const editable =
        canWriteTasks(role) && (current.state === "draft" || current.state === "uploaded");
    return (
        <>
            <h1 className="text-2xl font-semibold">
                {task.data.title}, version {current.seq}
            </h1>
            <Overview version={current} />
            <VersionContent version={current} editable={editable} onChanged={version.reload} />
            {editable && current.state === "draft" && (
                <VersionBundle versionId={current.id} onDone={version.reload} />
            )}
            <VersionActions
                version={current}
                writer={canWriteTasks(role)}
                reviewer={canReviewTasks(role)}
                own={current.created_by === me.data.id}
                onChanged={version.reload}
            />
            <a className="text-accent underline" href={`/tasks/${task.data.id}`}>
                Back to the task
            </a>
        </>
    );
}

function Overview({
    version,
}: {
    version: { state: string; waived: boolean; bundle: { bytes: number; sha256: string } | null };
}) {
    return (
        <Section id="overview" title="Where it stands">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted">State</dt>
                <dd>{version.state.replace("_", " ")}</dd>
                <dt className="text-muted">Bundle</dt>
                <dd>
                    {version.bundle === null
                        ? "None uploaded yet"
                        : `${version.bundle.bytes} bytes, SHA-256 ${version.bundle.sha256}`}
                </dd>
                {version.waived && (
                    <>
                        <dt className="text-muted">Validation</dt>
                        <dd>
                            Released without sandbox validation, on a reviewer's recorded waiver
                        </dd>
                    </>
                )}
            </dl>
        </Section>
    );
}
