"use client";

import { sessionsResponseSchema } from "@aura/contracts/api/identity";
import { useCallback, useState } from "react";
import { apiDo, apiGet, messageOf } from "../lib/api.ts";
import { withStepUp } from "../lib/passkeys.ts";
import { buttonDanger, buttonQuiet } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

const METHOD_LABEL: Record<string, string> = {
    passkey: "Passkey",
    email_link: "Email link",
    email_code: "Email code",
    github: "GitHub",
    google: "Google",
};

export function AccountSessions() {
    const load = useCallback(() => apiGet("/me/sessions", sessionsResponseSchema), []);
    const { data, error, reload } = useLoad(load);
    const [message, setMessage] = useState("");

    const act = async (work: () => Promise<void>) => {
        try {
            await work();
            setMessage("");
            reload();
        } catch (failure) {
            setMessage(messageOf(failure));
        }
    };

    return (
        <Section id="sessions" title="Devices signed in">
            {error !== "" && <Notice text={error} bad />}
            <ul className="mb-3 flex flex-col gap-2">
                {data?.items.map((item) => (
                    <li
                        key={item.id}
                        className="flex items-center justify-between gap-3 border-b border-line pb-2"
                    >
                        <span>
                            {METHOD_LABEL[item.auth_method] ?? item.auth_method}
                            {item.current ? " (this device)" : ""}
                            <span className="block text-sm text-muted">
                                Last active {new Date(item.last_seen_at).toLocaleString()}
                                {item.user_agent === null ? "" : ` · ${item.user_agent}`}
                            </span>
                        </span>
                        {!item.current && (
                            <button
                                type="button"
                                className={buttonQuiet}
                                onClick={() =>
                                    act(() =>
                                        apiDo(`/me/sessions/${item.id}`, { method: "DELETE" }),
                                    )
                                }
                            >
                                Sign out
                            </button>
                        )}
                    </li>
                ))}
            </ul>
            <button
                type="button"
                className={buttonDanger}
                onClick={() =>
                    act(async () => {
                        await withStepUp(() => apiDo("/auth/logout-all", { method: "POST" }));
                        window.location.assign("/sign-in");
                    })
                }
            >
                Sign out everywhere
            </button>
            {message !== "" && <Notice text={message} bad />}
        </Section>
    );
}
