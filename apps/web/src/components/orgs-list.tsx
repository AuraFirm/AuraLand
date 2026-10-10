"use client";

import { CREATABLE_ORG_KINDS, orgSchema, orgsResponseSchema } from "@aura/contracts/api/orgs";
import { type FormEvent, useCallback, useState } from "react";
import { z } from "zod";
import { apiGet, apiSend, messageOf } from "../lib/api.ts";
import { button, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

const kindSchema = z.enum(CREATABLE_ORG_KINDS);

const KIND_LABEL: Record<string, string> = {
    personal: "Personal space",
    university: "University",
    company: "Company",
    ai_lab: "AI lab",
    community: "Community",
    platform: "Platform",
};

export function OrgsList() {
    const load = useCallback(() => apiGet("/orgs", orgsResponseSchema), []);
    const { data, error, reload } = useLoad(load);
    return (
        <>
            <Section id="orgs" title="Your organizations">
                {error !== "" && <Notice text={error} bad />}
                <ul className="flex flex-col gap-2">
                    {data?.items.map((org) => (
                        <li
                            key={org.id}
                            className="flex items-center justify-between gap-3 border-b border-line pb-2"
                        >
                            <a className="text-accent underline" href={`/orgs/${org.id}`}>
                                {org.name}
                            </a>
                            <span className="text-sm text-muted">
                                {KIND_LABEL[org.kind] ?? org.kind} · {org.role}
                                {org.verification_state === "verified" ? " · verified" : ""}
                            </span>
                        </li>
                    ))}
                </ul>
            </Section>
            <CreateOrgForm onCreated={reload} />
        </>
    );
}

function CreateOrgForm({ onCreated }: { onCreated: () => void }) {
    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");
    const [kind, setKind] = useState<(typeof CREATABLE_ORG_KINDS)[number]>("community");
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        try {
            await apiSend("/orgs", orgSchema, { method: "POST", body: { name, slug, kind } });
            setName("");
            setSlug("");
            setFailed(false);
            setMessage("Organization created.");
            onCreated();
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };

    return (
        <Section id="create-org" title="Create an organization">
            <form onSubmit={submit} className="flex flex-col gap-3">
                <label htmlFor="org-name">Name</label>
                <input
                    id="org-name"
                    className={input}
                    required
                    maxLength={120}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
                <label htmlFor="org-slug">Address (letters, digits and dashes)</label>
                <input
                    id="org-slug"
                    className={input}
                    required
                    minLength={3}
                    maxLength={40}
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                />
                <label htmlFor="org-kind">Kind</label>
                <select
                    id="org-kind"
                    className={input}
                    value={kind}
                    onChange={(e) => setKind(kindSchema.parse(e.target.value))}
                >
                    {CREATABLE_ORG_KINDS.map((value) => (
                        <option key={value} value={value}>
                            {KIND_LABEL[value]}
                        </option>
                    ))}
                </select>
                <button type="submit" className={button}>
                    Create
                </button>
            </form>
            {message !== "" && <Notice text={message} bad={failed} />}
        </Section>
    );
}
