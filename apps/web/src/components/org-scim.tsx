"use client";

import type { OrgItem } from "@aura/contracts/api/orgs";
import { scimTokenCreatedSchema, scimTokensResponseSchema } from "@aura/contracts/api/sso";
import { useCallback, useState } from "react";
import { apiDo, apiGet, apiSend, messageOf } from "../lib/api.ts";
import { withStepUp } from "../lib/passkeys.ts";
import { button, buttonDanger } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

// Provisioning tokens for the organization's identity provider. A token is shown once, when it is made.
export function OrgScim({ org }: { org: OrgItem }) {
    const load = useCallback(
        () => apiGet(`/orgs/${org.id}/scim-tokens`, scimTokensResponseSchema),
        [org.id],
    );
    const { data, error, reload } = useLoad(load);
    const [shown, setShown] = useState<{ token: string; base: string } | null>(null);
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
    const create = () =>
        run(async () => {
            const made = await withStepUp(() =>
                apiSend(`/orgs/${org.id}/scim-tokens`, scimTokenCreatedSchema, { method: "POST" }),
            );
            setShown({ token: made.token, base: made.base_url });
        }, "Token created.");
    const revoke = (id: string) =>
        run(
            () => withStepUp(() => apiDo(`/scim-tokens/${id}`, { method: "DELETE" })),
            "Token revoked.",
        );

    return (
        <Section id="scim" title="Provisioning (SCIM)">
            {error !== "" && <Notice text={error} bad />}
            {shown !== null && <ShownToken token={shown.token} base={shown.base} />}
            <TokenList tokens={data?.tokens ?? []} onRevoke={revoke} />
            <button type="button" className={button} onClick={create}>
                Create provisioning token
            </button>
            {message !== "" && <Notice text={message} bad={failed} />}
        </Section>
    );
}

function ShownToken({ token, base }: { token: string; base: string }) {
    return (
        <div className="mb-4 rounded-[var(--radius-m)] border border-line p-3" role="status">
            <p className="mb-2 font-semibold">Copy this token now. It is shown only once.</p>
            <code className="block break-all font-mono">{token}</code>
            <p className="mt-2 text-sm text-muted">Base URL: {base}</p>
        </div>
    );
}

type Token = { id: string; revoked: boolean; last_used_at: string | null };

function TokenList({ tokens, onRevoke }: { tokens: Token[]; onRevoke: (id: string) => void }) {
    return (
        <ul className="mb-4 flex flex-col gap-2">
            {tokens.map((token) => (
                <li
                    key={token.id}
                    className="flex items-center justify-between gap-3 border-b border-line pb-2"
                >
                    <span>
                        <span className="font-mono text-sm">{token.id}</span>
                        <span className="block text-sm text-muted">{status(token)}</span>
                    </span>
                    {!token.revoked && (
                        <button
                            type="button"
                            className={buttonDanger}
                            onClick={() => onRevoke(token.id)}
                        >
                            Revoke token {token.id}
                        </button>
                    )}
                </li>
            ))}
        </ul>
    );
}

function status(token: Token): string {
    if (token.revoked) return "Revoked";
    return token.last_used_at === null
        ? "Never used"
        : `Last used ${new Date(token.last_used_at).toLocaleString()}`;
}
