"use client";

import type { OrgItem } from "@aura/contracts/api/orgs";
import {
    ssoConnectionSchema,
    ssoDomainSchema,
    ssoDomainsResponseSchema,
} from "@aura/contracts/api/sso";
import { type FormEvent, useCallback, useState } from "react";
import { ApiError, apiDo, apiGet, apiSend, detailOf } from "../lib/api.ts";
import { withStepUp } from "../lib/passkeys.ts";
import { button, buttonDanger, buttonQuiet, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

// Single sign-on: connect the organization's OpenID Connect provider, prove its email domains, then optionally require it.
export function OrgSso({ org }: { org: OrgItem }) {
    const loadConnection = useCallback(async () => {
        try {
            return { connection: await apiGet(`/orgs/${org.id}/sso`, ssoConnectionSchema) };
        } catch (failure) {
            if (failure instanceof ApiError && failure.status === 404) return { connection: null };
            throw failure;
        }
    }, [org.id]);
    const loadDomains = useCallback(
        () => apiGet(`/orgs/${org.id}/sso/domains`, ssoDomainsResponseSchema),
        [org.id],
    );
    const connection = useLoad(loadConnection);
    const domains = useLoad(loadDomains);
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);

    const run = async (work: () => Promise<void>, done: string) => {
        try {
            await work();
            setFailed(false);
            setMessage(done);
            connection.reload();
            domains.reload();
        } catch (failure) {
            setFailed(true);
            setMessage(detailOf(failure));
        }
    };

    return (
        <Section id="sso" title="Single sign-on">
            {connection.error !== "" && <Notice text={connection.error} bad />}
            <ConnectionForm org={org} current={connection.data?.connection ?? null} run={run} />
            <DomainList org={org} domains={domains.data?.domains ?? []} run={run} />
            {connection.data?.connection != null && (
                <label className="mt-4 flex items-center gap-2">
                    <input
                        type="checkbox"
                        checked={connection.data.connection.enforced}
                        onChange={(e) =>
                            run(
                                () =>
                                    withStepUp(() =>
                                        apiSend(
                                            `/orgs/${org.id}/sso/enforcement`,
                                            ssoConnectionSchema,
                                            { method: "PUT", body: { enforced: e.target.checked } },
                                        ),
                                    ).then(() => undefined),
                                e.target.checked
                                    ? "Single sign-on is now required."
                                    : "Single sign-on is no longer required.",
                            )
                        }
                    />
                    Require single sign-on for people with these domains (owners keep other ways in)
                </label>
            )}
            {message !== "" && <Notice text={message} bad={failed} />}
        </Section>
    );
}

type Run = (work: () => Promise<void>, done: string) => Promise<void>;

function Field(props: {
    id: string;
    label: string;
    value: string;
    onChange: (v: string) => void;
    type?: string;
    max?: number;
}) {
    return (
        <>
            <label htmlFor={props.id}>{props.label}</label>
            <input
                id={props.id}
                className={input}
                type={props.type ?? "text"}
                required
                autoComplete="off"
                maxLength={props.max ?? 500}
                value={props.value}
                onChange={(e) => props.onChange(e.target.value)}
            />
        </>
    );
}

function ConnectionForm({
    org,
    current,
    run,
}: {
    org: OrgItem;
    current: { issuer: string; client_id: string } | null;
    run: Run;
}) {
    const [issuer, setIssuer] = useState("");
    const [clientId, setClientId] = useState("");
    const [clientSecret, setClientSecret] = useState("");
    const save = (event: FormEvent) => {
        event.preventDefault();
        void run(async () => {
            await withStepUp(() =>
                apiSend(`/orgs/${org.id}/sso`, ssoConnectionSchema, {
                    method: "PUT",
                    body: { issuer, client_id: clientId, client_secret: clientSecret },
                }),
            );
            setClientSecret("");
        }, "Connection saved.");
    };
    return (
        <form onSubmit={save} className="mb-4 flex flex-col gap-2">
            {current !== null && (
                <p className="text-sm text-muted">
                    Connected to {current.issuer} as client {current.client_id}.
                </p>
            )}
            <ConnectionFields
                values={{ issuer, clientId, clientSecret }}
                set={{ setIssuer, setClientId, setClientSecret }}
            />
            <span className="flex gap-2">
                <button type="submit" className={button}>
                    Save connection
                </button>
                {current !== null && (
                    <button
                        type="button"
                        className={buttonDanger}
                        onClick={() =>
                            run(
                                () =>
                                    withStepUp(() =>
                                        apiDo(`/orgs/${org.id}/sso`, { method: "DELETE" }),
                                    ),
                                "Connection removed.",
                            )
                        }
                    >
                        Remove connection
                    </button>
                )}
            </span>
        </form>
    );
}

function DomainList({
    org,
    domains,
    run,
}: {
    org: OrgItem;
    domains: { domain: string; txt_name: string; txt_value: string; verified: boolean }[];
    run: Run;
}) {
    const [domain, setDomain] = useState("");
    const add = (event: FormEvent) => {
        event.preventDefault();
        void run(async () => {
            await apiSend(`/orgs/${org.id}/sso/domains`, ssoDomainSchema, {
                method: "POST",
                body: { domain },
            });
            setDomain("");
        }, "Domain added. Publish the record shown, then verify.");
    };
    const verify = (name: string) =>
        run(
            () =>
                withStepUp(() =>
                    apiSend(
                        `/orgs/${org.id}/sso/domains/${name}/verify`,
                        ssoDomainsResponseSchema,
                        { method: "POST" },
                    ),
                ).then(() => undefined),
            "Domain verified.",
        );
    return (
        <div>
            <h3 className="mb-2 font-semibold">Email domains</h3>
            <ul className="mb-3 flex flex-col gap-2">
                {domains.map((d) => (
                    <DomainRow key={d.domain} domain={d} onVerify={() => verify(d.domain)} />
                ))}
            </ul>
            <form onSubmit={add} className="flex flex-col gap-2">
                <label htmlFor="sso-domain">Domain to claim</label>
                <input
                    id="sso-domain"
                    className={input}
                    required
                    maxLength={253}
                    value={domain}
                    onChange={(e) => setDomain(e.target.value.toLowerCase())}
                />
                <button type="submit" className={buttonQuiet}>
                    Add domain
                </button>
            </form>
        </div>
    );
}

type DomainInfo = { domain: string; txt_name: string; txt_value: string; verified: boolean };

function DomainRow({ domain, onVerify }: { domain: DomainInfo; onVerify: () => void }) {
    return (
        <li className="flex flex-col gap-1 border-b border-line pb-2">
            <span>
                {domain.domain} {domain.verified ? "· verified" : "· not verified"}
            </span>
            {!domain.verified && (
                <>
                    <span className="break-all text-sm text-muted">
                        TXT record {domain.txt_name} = {domain.txt_value}
                    </span>
                    <button type="button" className={buttonQuiet} onClick={onVerify}>
                        Verify {domain.domain}
                    </button>
                </>
            )}
        </li>
    );
}

interface Values {
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: string;
}
interface Setters {
    readonly setIssuer: (value: string) => void;
    readonly setClientId: (value: string) => void;
    readonly setClientSecret: (value: string) => void;
}

function ConnectionFields({ values, set }: { values: Values; set: Setters }) {
    return (
        <>
            <Field
                id="sso-issuer"
                label="Issuer address (https)"
                type="url"
                value={values.issuer}
                onChange={set.setIssuer}
            />
            <Field
                id="sso-client"
                label="Client id"
                max={200}
                value={values.clientId}
                onChange={set.setClientId}
            />
            <Field
                id="sso-secret"
                label="Client secret"
                type="password"
                max={400}
                value={values.clientSecret}
                onChange={set.setClientSecret}
            />
        </>
    );
}
