"use client";

import { type PasskeyItem, passkeysResponseSchema } from "@aura/contracts/api/passkeys";
import { type FormEvent, useCallback, useState } from "react";
import { apiDo, apiGet, messageOf } from "../lib/api.ts";
import { registerPasskey, usePasskeysSupported } from "../lib/passkeys.ts";
import { button, buttonDanger, buttonQuiet, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

export function AccountPasskeys() {
    const load = useCallback(() => apiGet("/me/passkeys", passkeysResponseSchema), []);
    const { data, error, reload } = useLoad(load);
    const [message, setMessage] = useState("");
    const supported = usePasskeysSupported();

    const act = async (work: () => Promise<void>, done: string) => {
        try {
            await work();
            setMessage(done);
            reload();
        } catch (failure) {
            setMessage(messageOf(failure));
        }
    };

    return (
        <Section id="passkeys" title="Passkeys">
            {error !== "" && <Notice text={error} bad />}
            <ul className="mb-4 flex flex-col gap-2">
                {data?.items.map((item) => (
                    <PasskeyRow
                        key={item.id}
                        item={item}
                        onRename={(name) =>
                            act(
                                () =>
                                    apiDo(`/me/passkeys/${item.id}`, {
                                        method: "PATCH",
                                        body: { name },
                                    }),
                                "Passkey renamed.",
                            )
                        }
                        onRemove={() =>
                            act(
                                () => apiDo(`/me/passkeys/${item.id}`, { method: "DELETE" }),
                                "Passkey removed.",
                            )
                        }
                    />
                ))}
            </ul>
            {supported ? (
                <AddPasskeyForm
                    onAdd={(name) => act(() => registerPasskey(name), "Passkey added.")}
                />
            ) : (
                <Notice text="This browser does not support passkeys." />
            )}
            {message !== "" && <Notice text={message} />}
        </Section>
    );
}

interface RowProps {
    readonly item: PasskeyItem;
    readonly onRename: (name: string) => Promise<void>;
    readonly onRemove: () => Promise<void>;
}

function PasskeyRow({ item, onRename, onRemove }: RowProps) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(item.name);
    const save = async (event: FormEvent) => {
        event.preventDefault();
        await onRename(draft);
        setEditing(false);
    };
    return (
        <li className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-2">
            {editing ? (
                <form onSubmit={save} className="flex gap-2">
                    <label className="sr-only" htmlFor={`name-${item.id}`}>
                        New name
                    </label>
                    <input
                        id={`name-${item.id}`}
                        className={input}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        required
                        maxLength={80}
                    />
                    <button type="submit" className={buttonQuiet}>
                        Save
                    </button>
                </form>
            ) : (
                <span>
                    {item.name}
                    <span className="block text-sm text-muted">
                        Added {new Date(item.created_at).toLocaleDateString()}
                        {item.last_used_at === null
                            ? ""
                            : ` · used ${new Date(item.last_used_at).toLocaleDateString()}`}
                    </span>
                </span>
            )}
            <span className="flex gap-2">
                <button type="button" className={buttonQuiet} onClick={() => setEditing(true)}>
                    Rename
                </button>
                <button type="button" className={buttonDanger} onClick={onRemove}>
                    Remove
                </button>
            </span>
        </li>
    );
}

function AddPasskeyForm({ onAdd }: { onAdd: (name: string | undefined) => Promise<void> }) {
    const [name, setName] = useState("");
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        await onAdd(name.trim() === "" ? undefined : name.trim());
        setName("");
    };
    return (
        <form onSubmit={submit} className="flex flex-col gap-2">
            <label htmlFor="new-passkey-name">Name for the new passkey (optional)</label>
            <input
                id="new-passkey-name"
                className={input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
            />
            <button type="submit" className={button}>
                Add a passkey
            </button>
        </form>
    );
}
