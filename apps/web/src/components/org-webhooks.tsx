"use client";

import type { OrgItem } from "@aura/contracts/api/orgs";
import {
    WEBHOOK_EVENTS,
    webhookDeliveriesResponseSchema,
    webhookSecretSchema,
    webhooksResponseSchema,
} from "@aura/contracts/api/webhooks";
import { type FormEvent, useCallback, useState } from "react";
import { apiDo, apiGet, apiSend, messageOf } from "../lib/api.ts";
import { withStepUp } from "../lib/passkeys.ts";
import { button, buttonDanger, buttonQuiet, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

type Hook = { id: string; url: string; events: string[]; active: boolean };

// Webhook endpoints: where the organization wants to hear about events, signed with a secret shown once.
export function OrgWebhooks({ org }: { org: OrgItem }) {
    const load = useCallback(
        () => apiGet(`/orgs/${org.id}/webhooks`, webhooksResponseSchema),
        [org.id],
    );
    const { data, error, reload } = useLoad(load);
    const [secret, setSecret] = useState("");
    const [log, setLog] = useState("");
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);

    const run = async (work: () => Promise<void>, done: string) => {
        try {
            await work();
            setFailed(false);
            setMessage(done);
            reload();
        } catch (failure) {
            setFailed(true);
            setMessage(messageOf(failure));
        }
    };
    const create = (url: string) =>
        run(async () => {
            const body = { url, events: [...WEBHOOK_EVENTS].slice(0, 1) };
            const made = await withStepUp(() =>
                apiSend(`/orgs/${org.id}/webhooks`, webhookSecretSchema, { method: "POST", body }),
            );
            setSecret(made.secret);
        }, "Endpoint added.");
    const rotate = (id: string) =>
        run(async () => {
            const made = await withStepUp(() =>
                apiSend(`/webhooks/${id}/rotate-secret`, webhookSecretSchema, { method: "POST" }),
            );
            setSecret(made.secret);
        }, "Secret replaced. The old one keeps working for 24 hours.");
    const remove = (id: string) =>
        run(() => apiDo(`/webhooks/${id}`, { method: "DELETE" }), "Endpoint switched off.");
    const showLog = (id: string) =>
        run(async () => {
            const result = await apiGet(
                `/webhooks/${id}/deliveries`,
                webhookDeliveriesResponseSchema,
            );
            const lines = result.deliveries.map(
                (d) => `${d.event_type}: ${d.state}, ${d.attempts} attempt(s)`,
            );
            setLog(lines.join("\n") || "No deliveries yet.");
        }, "Deliveries loaded.");

    return (
        <Section id="webhooks" title="Webhooks">
            {error !== "" && <Notice text={error} bad />}
            {secret !== "" && <ShownSecret secret={secret} />}
            <ul className="mb-4 flex flex-col gap-2">
                {data?.webhooks.map((hook) => (
                    <HookRow key={hook.id} hook={hook} on={{ rotate, remove, showLog }} />
                ))}
            </ul>
            {log !== "" && (
                <pre className="mb-4 whitespace-pre-wrap rounded-[var(--radius-m)] border border-line p-3">
                    {log}
                </pre>
            )}
            <AddForm onAdd={create} />
            {message !== "" && <Notice text={message} bad={failed} />}
        </Section>
    );
}

function ShownSecret({ secret }: { secret: string }) {
    return (
        <div className="mb-4 rounded-[var(--radius-m)] border border-line p-3" role="status">
            <p className="mb-2 font-semibold">
                Copy this signing secret now. It is shown only once.
            </p>
            <code className="break-all font-mono">{secret}</code>
        </div>
    );
}

interface Actions {
    readonly rotate: (id: string) => void;
    readonly remove: (id: string) => void;
    readonly showLog: (id: string) => void;
}

function HookRow({ hook, on }: { hook: Hook; on: Actions }) {
    return (
        <li className="flex flex-col gap-2 border-b border-line pb-2">
            <span className="break-all">{hook.url}</span>
            <span className="text-sm text-muted">
                {hook.active ? hook.events.join(", ") : "Switched off"}
            </span>
            {hook.active && (
                <span className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        className={buttonQuiet}
                        onClick={() => on.rotate(hook.id)}
                    >
                        Replace secret of {hook.url}
                    </button>
                    <button
                        type="button"
                        className={buttonQuiet}
                        onClick={() => on.showLog(hook.id)}
                    >
                        Show deliveries of {hook.url}
                    </button>
                    <button
                        type="button"
                        className={buttonDanger}
                        onClick={() => on.remove(hook.id)}
                    >
                        Switch off {hook.url}
                    </button>
                </span>
            )}
        </li>
    );
}

function AddForm({ onAdd }: { onAdd: (url: string) => Promise<void> }) {
    const [url, setUrl] = useState("");
    const submit = (event: FormEvent) => {
        event.preventDefault();
        void onAdd(url).then(() => setUrl(""));
    };
    return (
        <form onSubmit={submit} className="flex flex-col gap-2">
            <label htmlFor="webhook-url">Address to send environment run results to (https)</label>
            <input
                id="webhook-url"
                className={input}
                type="url"
                required
                maxLength={2000}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
            />
            <button type="submit" className={button}>
                Add endpoint
            </button>
        </form>
    );
}
