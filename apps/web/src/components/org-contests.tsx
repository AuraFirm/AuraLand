"use client";

import { contestSchema } from "@aura/contracts/api/contests";
import type { OrgItem } from "@aura/contracts/api/orgs";
import { type FormEvent, useState } from "react";
import { apiSend, messageOf } from "../lib/api.ts";
import { instantFromLocalInput } from "../lib/contest-time.ts";
import { canManageContests } from "../lib/roles.ts";
import { button, input } from "../lib/styles.ts";
import { ContestsList } from "./contests-list.tsx";
import { Notice, Section } from "./section.tsx";
import { TextField } from "./text-field.tsx";

// The organization's contests (drafts included for its staff) and a form to start one.
export function OrgContests({ org }: { org: OrgItem }) {
    const [version, setVersion] = useState(0);
    return (
        <>
            <ContestsList key={version} query={`&org_id=${org.id}`} />
            {canManageContests(org.role) && (
                <CreateContest orgId={org.id} onCreated={() => setVersion((v) => v + 1)} />
            )}
        </>
    );
}

function CreateContest({ orgId, onCreated }: { orgId: string; onCreated: () => void }) {
    const [values, setValues] = useState<Values>({
        title: "",
        slug: "",
        format: "icpc",
        starts: "",
        ends: "",
    });
    const set = (change: Partial<Values>) => setValues((current) => ({ ...current, ...change }));
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        try {
            const created = await apiSend(`/orgs/${orgId}/contests`, contestSchema, {
                method: "POST",
                body: {
                    slug: values.slug,
                    title: values.title,
                    rules: { format: values.format },
                    starts_at: instantFromLocalInput(values.starts),
                    ends_at: instantFromLocalInput(values.ends),
                },
            });
            setFailed(false);
            setMessage("Contest created as a draft. Open it to add problems and publish.");
            set({ title: "", slug: "" });
            onCreated();
            window.location.assign(`/arena/contests/${created.id}`);
        } catch (error) {
            setFailed(true);
            setMessage(messageOf(error));
        }
    };
    return (
        <Section id="new-contest" title="New contest">
            <form onSubmit={submit} className="flex flex-col gap-2">
                <ContestFields values={values} set={set} />
                <button type="submit" className={button}>
                    Create contest
                </button>
                {message !== "" && <Notice text={message} bad={failed} />}
            </form>
        </Section>
    );
}

interface Values {
    title: string;
    slug: string;
    format: "icpc" | "ioi";
    starts: string;
    ends: string;
}

function ContestFields(props: { values: Values; set: (change: Partial<Values>) => void }) {
    const { values, set } = props;
    return (
        <>
            <TextField
                id="contest-title"
                label="Contest title"
                value={values.title}
                onChange={(title) => set({ title })}
                maxLength={120}
            />
            <TextField
                id="contest-slug"
                label="Address (lowercase letters, digits and dashes)"
                value={values.slug}
                onChange={(slug) => set({ slug })}
                pattern="[a-z0-9][a-z0-9-]{1,62}"
            />
            <label htmlFor="contest-format">Format</label>
            <select
                id="contest-format"
                className={input}
                value={values.format}
                onChange={(e) => set({ format: e.target.value === "ioi" ? "ioi" : "icpc" })}
            >
                <option value="icpc">ICPC (solved count and penalty)</option>
                <option value="ioi">IOI (best score per problem)</option>
            </select>
            <TextField
                id="contest-starts"
                label="Starts (your time zone)"
                type="datetime-local"
                value={values.starts}
                onChange={(starts) => set({ starts })}
            />
            <TextField
                id="contest-ends"
                label="Ends (your time zone; 5 minutes to 7 days after the start)"
                type="datetime-local"
                value={values.ends}
                onChange={(ends) => set({ ends })}
            />
        </>
    );
}
