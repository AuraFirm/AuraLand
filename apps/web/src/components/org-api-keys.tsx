"use client";

import {
    type ApiKeyItem,
    apiKeyCreatedSchema,
    apiKeysResponseSchema,
} from "@aura/contracts/api/api-keys";
import type { OrgItem } from "@aura/contracts/api/orgs";
import { type FormEvent, useCallback, useState } from "react";
import { apiDo, apiGet, apiSend, messageOf } from "../lib/api.ts";
import { withStepUp } from "../lib/passkeys.ts";
import { button, buttonDanger, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

export function OrgApiKeys({ org }: { org: OrgItem }) {
    const load = useCallback(
        () => apiGet(`/orgs/${org.id}/api-keys`, apiKeysResponseSchema),
        [org.id],
    );
    const { data, error, reload } = useLoad(load);
    const [name, setName] = useState("");
    const [shownKey, setShownKey] = useState("");
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);

    const create = async (event: FormEvent) => {
        event.preventDefault();
        try {
            const made = await withStepUp(() =>
                apiSend(`/orgs/${org.id}/api-keys`, apiKeyCreatedSchema, {
                    method: "POST",
                    body: { name },
                }),
            );
            setShownKey(made.key);
            setName("");
            setFailed(false);
            setMessage("");
            reload();
        } catch (failure) {
            setFailed(true);
            setMessage(messageOf(failure));
        }
    };
    const revoke = async (id: string) => {
        try {
            await withStepUp(() => apiDo(`/orgs/${org.id}/api-keys/${id}`, { method: "DELETE" }));
            setFailed(false);
            setMessage("Key revoked.");
            reload();
        } catch (failure) {
            setFailed(true);
            setMessage(messageOf(failure));
        }
    };

    return (
        <Section id="api-keys" title="API keys">
            {error !== "" && <Notice text={error} bad />}
            {shownKey !== "" && (
                <div
                    className="mb-4 rounded-(--radius-m) border border-line p-3"
                    role="status"
                >
                    <p className="mb-2 font-semibold">Copy this key now. It is shown only once.</p>
                    <code className="break-all font-mono">{shownKey}</code>
                </div>
            )}
            <ul className="mb-4 flex flex-col gap-2">
                {data?.items.map((key) => (
                    <KeyRow key={key.id} item={key} onRevoke={() => revoke(key.id)} />
                ))}
            </ul>
            <CreateKeyForm name={name} setName={setName} onSubmit={create} />
            {message !== "" && <Notice text={message} bad={failed} />}
        </Section>
    );
}

function KeyRow({ item, onRevoke }: { item: ApiKeyItem; onRevoke: () => void }) {
    return (
        <li className="flex items-center justify-between gap-3 border-b border-line pb-2">
            <span>
                {item.name}
                <span className="ml-2 font-mono text-sm text-muted">aura_{item.prefix}_…</span>
                <span className="block text-sm text-muted">
                    {item.revoked_at !== null
                        ? "Revoked"
                        : `Expires ${new Date(item.expires_at).toLocaleDateString()}`}
                </span>
            </span>
            {item.revoked_at === null && (
                <button type="button" className={buttonDanger} onClick={onRevoke}>
                    Revoke key {item.name}
                </button>
            )}
        </li>
    );
}

interface FormProps {
    readonly name: string;
    readonly setName: (value: string) => void;
    readonly onSubmit: (event: FormEvent) => void;
}

function CreateKeyForm({ name, setName, onSubmit }: FormProps) {
    return (
        <form onSubmit={onSubmit} className="flex flex-col gap-2">
            <label htmlFor="key-name">Name for the new key</label>
            <input
                id="key-name"
                className={input}
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" className={button}>
                Create key
            </button>
        </form>
    );
}
