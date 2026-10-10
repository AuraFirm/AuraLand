"use client";

import { authMethodsResponseSchema } from "@aura/contracts/api/account";
import { identitiesResponseSchema, oauthStartResponseSchema } from "@aura/contracts/api/oauth";
import { useCallback, useState } from "react";
import { apiDo, apiGet, apiSend, messageOf } from "../lib/api.ts";
import { buttonDanger, buttonQuiet } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

const LABEL = { github: "GitHub", google: "Google" } as const;

export function AccountIdentities() {
    const loadIdentities = useCallback(
        () => apiGet("/me/identities", identitiesResponseSchema),
        [],
    );
    const loadMethods = useCallback(() => apiGet("/auth/methods", authMethodsResponseSchema), []);
    const identities = useLoad(loadIdentities);
    const methods = useLoad(loadMethods);
    const [message, setMessage] = useState("");

    const connect = async (provider: "github" | "google") => {
        try {
            const started = await apiSend(
                `/auth/oauth/${provider}/start`,
                oauthStartResponseSchema,
                {
                    method: "POST",
                    body: { purpose: "link" },
                },
            );
            window.location.assign(started.authorization_url);
        } catch (failure) {
            setMessage(messageOf(failure));
        }
    };
    const disconnect = async (provider: "github" | "google") => {
        try {
            await apiDo(`/me/identities/${provider}`, { method: "DELETE" });
            identities.reload();
        } catch (failure) {
            setMessage(messageOf(failure));
        }
    };

    const linked = new Set(identities.data?.items.map((item) => item.provider));
    const available = methods.data?.oauth ?? [];
    if (available.length === 0 && linked.size === 0) return null;
    return (
        <Section id="identities" title="Connected accounts">
            <ul className="flex flex-col gap-2">
                {available.map((provider) => (
                    <IdentityRow
                        key={provider}
                        provider={provider}
                        linked={linked.has(provider)}
                        onConnect={connect}
                        onDisconnect={disconnect}
                    />
                ))}
            </ul>
            {message !== "" && <Notice text={message} bad />}
        </Section>
    );
}

interface RowProps {
    readonly provider: "github" | "google";
    readonly linked: boolean;
    readonly onConnect: (provider: "github" | "google") => void;
    readonly onDisconnect: (provider: "github" | "google") => void;
}

function IdentityRow({ provider, linked, onConnect, onDisconnect }: RowProps) {
    return (
        <li className="flex items-center justify-between gap-3 border-b border-line pb-2">
            <span>
                {LABEL[provider]}
                <span className="ml-2 text-sm text-muted">
                    {linked ? "Connected" : "Not connected"}
                </span>
            </span>
            {linked ? (
                <button
                    type="button"
                    className={buttonDanger}
                    onClick={() => onDisconnect(provider)}
                >
                    Disconnect
                </button>
            ) : (
                <button type="button" className={buttonQuiet} onClick={() => onConnect(provider)}>
                    Connect
                </button>
            )}
        </li>
    );
}
