"use client";

import { sessionStatusSchema } from "@aura/contracts/api/account";
import { practiceProblemSchema } from "@aura/contracts/api/practice";
import { useCallback } from "react";
import { apiGet } from "../lib/api.ts";
import { useLoad } from "../lib/use-load.ts";
import { SafeHtml } from "./safe-html.tsx";
import { Notice } from "./section.tsx";
import { SubmitPanel } from "./submit-panel.tsx";

// One bank problem: the statement and a place to submit (signing in is asked of the API when submitting).
export function PracticeProblem({ id }: { id: string }) {
    const load = useCallback(() => apiGet(`/practice/${id}`, practiceProblemSchema), [id]);
    const { data, error } = useLoad(load);
    const loadStatus = useCallback(() => apiGet("/me/status", sessionStatusSchema), []);
    const status = useLoad(loadStatus);
    if (error !== "") return <Notice text="This problem is not in the practice bank." bad />;
    if (data === null) return <h1 className="text-2xl font-semibold">Practice problem</h1>;
    return (
        <>
            <h1 className="text-2xl font-semibold">{data.title}</h1>
            <p className="text-sm text-muted">
                {data.time_limit_ms} ms · {Math.round(data.memory_limit_kib / 1024)} MiB
            </p>
            <SafeHtml html={data.statement_html} label="Problem statement" />
            {status.data?.signed_in === true && (
                <SubmitPanel
                    versionId={data.id}
                    languages={data.languages}
                    submitPath={`/practice/${data.id}/submissions`}
                />
            )}
            {status.data?.signed_in === false && (
                <p>
                    <a
                        className="text-accent underline"
                        href={`/sign-in?next=/practice/${data.id}`}
                    >
                        Sign in
                    </a>{" "}
                    to submit a solution.
                </p>
            )}
        </>
    );
}
