"use client";

import { orgsResponseSchema } from "@aura/contracts/api/orgs";
import {
    type EMPLOYER_PURPOSES,
    employerReportSchema,
    employerSearchResponseSchema,
} from "@aura/contracts/api/passport";
import { useCallback, useState } from "react";
import { apiGet, messageOf } from "../lib/api.ts";
import { showInstant } from "../lib/contest-time.ts";
import { withStepUp } from "../lib/passkeys.ts";
import { button } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

type Report = ReturnType<typeof employerReportSchema.parse>;

// Employer access to credentials their holders made public. Each report opened is recorded and shown to the holder
// (who sees the organization's name and why, not who). Needs an approved employer organization and a passkey check.
export function EmployerView() {
    const orgs = useLoad(useCallback(() => apiGet("/orgs", orgsResponseSchema), []));
    const companies = orgs.data?.items.filter((org) => org.kind === "company") ?? [];
    const [chosen, setChosen] = useState("");
    const org = chosen === "" ? (companies[0]?.id ?? "") : chosen;
    return (
        <>
            <h1 className="text-2xl font-semibold">Employer</h1>
            {companies.length === 0 && orgs.data !== null && (
                <Notice text="You are not a member of a company organization. Employer access is by invitation of the platform." />
            )}
            {companies.length > 1 && (
                <label>
                    Organization
                    <select
                        className="ml-2 rounded border border-line bg-panel px-2 py-1"
                        value={org}
                        onChange={(e) => setChosen(e.target.value)}
                    >
                        {companies.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.name}
                            </option>
                        ))}
                    </select>
                </label>
            )}
            {org !== "" && <Search org={org} />}
        </>
    );
}

function Search({ org }: { org: string }) {
    const [message, setMessage] = useState("");
    const [found, setFound] = useState<ReturnType<
        typeof employerSearchResponseSchema.parse
    > | null>(null);
    const [report, setReport] = useState<Report | null>(null);
    const [purpose, setPurpose] = useState<(typeof EMPLOYER_PURPOSES)[number]>("hiring_screening");
    const list = async () => {
        try {
            setFound(
                await withStepUp(() =>
                    apiGet(`/employer/credentials?org_id=${org}`, employerSearchResponseSchema),
                ),
            );
            setMessage("");
        } catch (error) {
            setMessage(messageOf(error));
        }
    };
    const open = async (id: string) => {
        try {
            setReport(
                await withStepUp(() =>
                    apiGet(
                        `/employer/reports/${id}?org_id=${org}&purpose=${purpose}`,
                        employerReportSchema,
                    ),
                ),
            );
            setMessage("");
        } catch (error) {
            setMessage(messageOf(error));
        }
    };
    return (
        <>
            <Section id="search" title="Public credentials">
                <p className="mb-2 text-sm text-muted">
                    These name no one. Opening a report is recorded, and the holder can see that
                    your organization looked and why.
                </p>
                <label>
                    Purpose
                    <select
                        className="ml-2 rounded border border-line bg-panel px-2 py-1"
                        value={purpose}
                        onChange={(e) =>
                            setPurpose(
                                e.target.value === "verification"
                                    ? "verification"
                                    : "hiring_screening",
                            )
                        }
                    >
                        <option value="hiring_screening">Hiring screening</option>
                        <option value="verification">Verifying a claim</option>
                    </select>
                </label>
                <p className="mt-2">
                    <button type="button" className={button} onClick={list}>
                        Show public credentials
                    </button>
                </p>
                <Found found={found} onOpen={open} />
            </Section>
            {message !== "" && <Notice text={message} bad />}
            {report !== null && <ReportCard report={report} />}
        </>
    );
}

function ReportCard({ report }: { report: Report }) {
    return (
        <Section id="report" title={`${report.name}: ${report.outcome}`}>
            <ul>
                {report.summary.map((line) => (
                    <li key={line}>{line}</li>
                ))}
            </ul>
            <p className="mt-2 text-sm text-muted">
                Issued by {report.issuer}, assurance level {report.assurance_level}
                {report.environment === "development"
                    ? " (a development credential: it proves nothing)"
                    : ""}
                . This look has been recorded.
            </p>
            {report.reason !== undefined && <Notice text={report.reason} bad />}
        </Section>
    );
}

type Found = ReturnType<typeof employerSearchResponseSchema.parse>;

function Found({ found, onOpen }: { found: Found | null; onOpen: (id: string) => void }) {
    return (
        <ul className="mt-3">
            {found?.credentials.map((credential) => (
                <li key={credential.id} className="mb-2">
                    {credential.name} (assurance level {credential.assurance_level}, issued{" "}
                    {showInstant(credential.issued_at)}){" "}
                    <button type="button" className={button} onClick={() => onOpen(credential.id)}>
                        Open report
                    </button>
                </li>
            ))}
            {found?.credentials.length === 0 && <li>No public credentials yet.</li>}
        </ul>
    );
}
