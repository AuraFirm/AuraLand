"use client";

import { validationReportResponseSchema } from "@aura/contracts/api/validation";
import { useCallback } from "react";
import { apiGet } from "../lib/api.ts";
import { useLoad } from "../lib/use-load.ts";
import { validationLabel } from "../lib/validation-label.ts";
import { Notice, Section } from "./section.tsx";

// The latest validation report of a version: the conclusion, the score and every check with its detail.
// A task that is being validated has no report yet; the screen says so rather than showing nothing.
export function VersionValidation({ versionId, state }: { versionId: string; state: string }) {
    const load = useCallback(
        () => apiGet(`/task-versions/${versionId}/validation`, validationReportResponseSchema),
        [versionId],
    );
    const result = useLoad(load);
    if (result.error !== "") return <Notice text={result.error} bad />;
    const report = result.data?.report ?? null;
    if (report === null) {
        return state === "validating" ? (
            <Section id="validation" title="Validation">
                <p>Waiting for a judge node to run the task's own solutions.</p>
            </Section>
        ) : null;
    }
    return (
        <Section id="validation" title="Validation">
            <p className="font-semibold">{validationLabel(report)}</p>
            {report.score !== null && (
                <p>
                    Ungameability score {report.score.toFixed(2)} out of 100 (formula version{" "}
                    {report.score_version}); at least 70 is needed.
                </p>
            )}
            <ul className="mt-2 list-disc pl-5">
                {report.checks.map((check) => (
                    <li key={check.name}>
                        {check.ok ? "Passed" : "Failed"}: {check.name}
                        {check.detail === "" ? "" : ` (${check.detail})`}
                    </li>
                ))}
            </ul>
        </Section>
    );
}
