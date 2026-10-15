"use client";

import {
    createShareResponseSchema,
    credentialViewsResponseSchema,
    myCredentialsResponseSchema,
} from "@aura/contracts/api/passport";
import { VISIBILITIES } from "@aura/contracts/credentials";
import { useCallback, useState } from "react";
import { apiDo, apiGet, apiSend, detailOf } from "../lib/api.ts";
import { showInstant } from "../lib/contest-time.ts";
import { button, buttonQuiet } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

type Mine = ReturnType<typeof myCredentialsResponseSchema.parse>["credentials"][number];

const WHO_SEES: Record<Mine["visibility"], string> = {
    private: "Only you",
    link: "Anyone with a link you make",
    public: "Anyone",
};

// A person's own Passport: what has been signed about them and who may see it. Credentials start private.
export function PassportView() {
    const load = useCallback(() => apiGet("/me/credentials", myCredentialsResponseSchema), []);
    const { data, error, reload } = useLoad(load);
    return (
        <>
            <h1 className="text-2xl font-semibold">Your Passport</h1>
            {error !== "" && <Notice text={error} bad />}
            {data?.credentials.length === 0 && (
                <Notice text="You have no credentials yet. They appear here after a contest or exam you took finishes." />
            )}
            {data?.credentials.map((credential) => (
                <CredentialCard key={credential.id} credential={credential} onChanged={reload} />
            ))}
        </>
    );
}

function CredentialCard({ credential, onChanged }: { credential: Mine; onChanged: () => void }) {
    const [message, setMessage] = useState("");
    const [link, setLink] = useState("");
    const run = async (work: () => Promise<void>) => {
        try {
            await work();
            setMessage("");
            onChanged();
        } catch (failure) {
            setMessage(detailOf(failure));
        }
    };
    const setVisibility = (visibility: string) =>
        run(() =>
            apiDo(`/credentials/${credential.id}/visibility`, {
                method: "PUT",
                body: { visibility },
            }),
        );
    const makeLink = () =>
        run(async () => {
            const made = await apiSend(
                `/credentials/${credential.id}/shares`,
                createShareResponseSchema,
                {
                    method: "POST",
                    body: { days: 7 },
                },
            );
            setLink(made.url);
        });
    return (
        <Section id={`c-${credential.id}`} title={credential.name}>
            <p className="text-sm text-muted">
                Issued {showInstant(credential.issued_at)} · assurance level{" "}
                {credential.assurance_level}
                {credential.revoked ? " · revoked" : ""}
            </p>
            <VisibilityPicker credential={credential} onChange={setVisibility} />
            {credential.visibility !== "private" && (
                <p className="mt-2">
                    <a className="text-accent underline" href={`/verify/${credential.id}`}>
                        See the public page
                    </a>
                </p>
            )}
            {credential.visibility !== "private" && (
                <div className="mt-3">
                    <button type="button" className={button} onClick={makeLink}>
                        Make a link (lasts 7 days)
                    </button>
                    {link !== "" && (
                        <p className="mt-2 break-all">
                            Copy it now; it is not shown again: <code>{link}</code>
                        </p>
                    )}
                </div>
            )}
            <ShareList credential={credential} run={run} />
            {credential.visibility === "public" && <Views id={credential.id} />}
            {message !== "" && <Notice text={message} bad />}
        </Section>
    );
}

function VisibilityPicker(props: { credential: Mine; onChange: (visibility: string) => void }) {
    const { credential, onChange } = props;
    return (
        <label className="mt-3 block">
            Who can see this
            <select
                className="ml-2 rounded border border-line bg-panel px-2 py-1"
                value={credential.visibility}
                onChange={(e) => onChange(e.target.value)}
            >
                {VISIBILITIES.map((visibility) => (
                    <option key={visibility} value={visibility}>
                        {WHO_SEES[visibility]}
                    </option>
                ))}
            </select>
        </label>
    );
}

function ShareList(props: { credential: Mine; run: (work: () => Promise<void>) => Promise<void> }) {
    const { credential, run } = props;
    return (
        <ul className="mt-3">
            {credential.shares.map((share) => (
                <li key={share.id} className="mb-1">
                    Link until {showInstant(share.expires_at)}
                    {share.revoked ? " (revoked)" : ""}{" "}
                    {!share.revoked && (
                        <button
                            type="button"
                            className={buttonQuiet}
                            onClick={() =>
                                run(() =>
                                    apiDo(`/credentials/${credential.id}/shares/${share.id}`, {
                                        method: "DELETE",
                                    }),
                                )
                            }
                        >
                            Revoke this link
                        </button>
                    )}
                </li>
            ))}
        </ul>
    );
}

// Who looked at a public credential: the organization and why, not the person. Holders can always see this.
function Views({ id }: { id: string }) {
    const { data } = useLoad(
        useCallback(() => apiGet(`/credentials/${id}/views`, credentialViewsResponseSchema), [id]),
    );
    if (data === null) return null;
    return (
        <div className="mt-3">
            <h3 className="font-semibold">Who has looked</h3>
            {data.views.length === 0 && (
                <p className="text-sm text-muted">Nobody has opened a report yet.</p>
            )}
            <ul>
                {data.views.map((view) => (
                    <li key={`${view.org_name}${view.viewed_at}`}>
                        {view.org_name},{" "}
                        {view.purpose === "hiring_screening"
                            ? "hiring screening"
                            : "verifying a claim"}
                        , {showInstant(view.viewed_at)}
                    </li>
                ))}
            </ul>
        </div>
    );
}
