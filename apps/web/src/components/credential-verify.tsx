"use client";

import { verifyResponseSchema } from "@aura/contracts/api/passport";
import { useCallback } from "react";
import { apiGetPublic } from "../lib/api.ts";
import { showInstant } from "../lib/contest-time.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

type Result = ReturnType<typeof verifyResponseSchema.parse>;

// What each outcome means, in plain words, for someone who is not an engineer.
const HEADLINE: Record<Result["outcome"], string> = {
    valid: "This credential is valid",
    expired: "This credential has expired",
    revoked: "This credential was revoked",
    invalid: "This credential is not valid",
    unknown: "We have no public credential with this address",
};

// The public page for checking a credential. It reads only the published, signed documents (the API answers without
// its database), so it works when the rest of the product is down.
export function CredentialVerify({ id }: { id: string }) {
    const load = useCallback(() => apiGetPublic(`/credentials/${id}`, verifyResponseSchema), [id]);
    const { data, error } = useLoad(load);
    if (error !== "") return <Notice text="This address is not a credential." bad />;
    if (data === null) return <h1 className="text-2xl font-semibold">Checking…</h1>;
    return (
        <>
            <h1 className="text-2xl font-semibold">{HEADLINE[data.outcome]}</h1>
            {data.environment === "development" && (
                <Notice
                    text="This is a development credential. It was signed with a test key and proves nothing."
                    bad
                />
            )}
            {data.reason !== undefined && (
                <Notice text={data.reason} bad={data.outcome === "invalid"} />
            )}
            {data.name !== undefined && <Details result={data} />}
            {data.outcome === "unknown" && (
                <Notice text="It may not exist, or its holder has not made it public." />
            )}
            {data.jwt !== undefined && <Raw jwt={data.jwt} />}
        </>
    );
}

function Details({ result }: { result: Result }) {
    return (
        <Section id="what" title={result.name ?? ""}>
            <p>{result.description}</p>
            <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted">Issued by</dt>
                <dd>{result.issuer}</dd>
                <dt className="text-muted">Issued</dt>
                <dd>{result.issued_at === undefined ? "" : showInstant(result.issued_at)}</dd>
                {result.expires_at !== undefined && (
                    <>
                        <dt className="text-muted">Expires</dt>
                        <dd>{showInstant(result.expires_at)}</dd>
                    </>
                )}
                <dt className="text-muted">Assurance level</dt>
                <dd>{result.assurance_level}</dd>
            </dl>
            <p className="mt-3 text-sm text-muted">
                This shows that the event happened under the stated conditions and that this
                credential was signed by the issuer. It does not show anything else about the
                person. Assurance level 0 means no identity check; level 1 means the event's own
                rules were followed.
            </p>
        </Section>
    );
}

function Raw({ jwt }: { jwt: string }) {
    return (
        <Section id="check" title="Check it yourself">
            <p className="mb-2">
                The credential is a signed token. Any standard credential verifier can check it
                against the issuer's published keys; you do not need to trust this page.
            </p>
            <details>
                <summary>Show the signed token</summary>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-xs">
                    {jwt}
                </pre>
            </details>
        </Section>
    );
}
