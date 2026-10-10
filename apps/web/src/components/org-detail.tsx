"use client";

import { type OrgItem, orgSchema } from "@aura/contracts/api/orgs";
import { type FormEvent, useCallback, useState } from "react";
import { apiGet, apiSend, messageOf } from "../lib/api.ts";
import { button, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { OrgApiKeys } from "./org-api-keys.tsx";
import { OrgInvitations } from "./org-invitations.tsx";
import { OrgMembers } from "./org-members.tsx";
import { OrgTasks } from "./org-tasks.tsx";
import { Notice, Section } from "./section.tsx";

export function OrgDetail({ orgId }: { orgId: string }) {
    const load = useCallback(() => apiGet(`/orgs/${orgId}`, orgSchema), [orgId]);
    const { data, error, reload } = useLoad(load);
    if (error !== "") {
        return (
            <>
                <h1 className="text-2xl font-semibold">Organization</h1>
                <Notice text={error} bad />
                <a className="text-accent underline" href="/orgs">
                    Back to organizations
                </a>
            </>
        );
    }
    if (data === null) return <h1 className="text-2xl font-semibold">Organization</h1>;
    const manages = data.role === "owner" || data.role === "admin";
    return (
        <>
            <h1 className="text-2xl font-semibold">{data.name}</h1>
            <Overview org={data} onChanged={reload} />
            <OrgTasks org={data} />
            <OrgMembers org={data} />
            {manages && <OrgInvitations org={data} />}
            {manages && <OrgApiKeys org={data} />}
            <a className="text-accent underline" href="/orgs">
                All organizations
            </a>
        </>
    );
}

function Overview({ org, onChanged }: { org: OrgItem; onChanged: () => void }) {
    const [name, setName] = useState(org.name);
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const manages = org.role === "owner" || org.role === "admin";

    const save = async (event: FormEvent) => {
        event.preventDefault();
        try {
            await apiSend(`/orgs/${org.id}`, orgSchema, { method: "PATCH", body: { name } });
            setFailed(false);
            setMessage("Saved.");
            onChanged();
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };

    return (
        <Section id="overview" title="Overview">
            <dl className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted">Address</dt>
                <dd>{org.slug}</dd>
                <dt className="text-muted">Your role</dt>
                <dd>{org.role}</dd>
                <dt className="text-muted">Status</dt>
                <dd>{org.verification_state === "verified" ? "Verified" : "Not yet verified"}</dd>
            </dl>
            {manages && (
                <form onSubmit={save} className="flex flex-col gap-2">
                    <label htmlFor="rename">Name</label>
                    <input
                        id="rename"
                        className={input}
                        required
                        maxLength={120}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                    <button type="submit" className={button}>
                        Save name
                    </button>
                </form>
            )}
            {message !== "" && <Notice text={message} bad={failed} />}
        </Section>
    );
}
