"use client";

import { type InvitationItem, invitationsResponseSchema } from "@aura/contracts/api/invitations";
import type { OrgItem } from "@aura/contracts/api/orgs";
import { type FormEvent, useCallback, useState } from "react";
import { z } from "zod";
import { apiDo, apiGet, apiSend, messageOf } from "../lib/api.ts";
import { withStepUp } from "../lib/passkeys.ts";
import { button, buttonQuiet, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

const created = z.object({ id: z.string() }).passthrough();

export function OrgInvitations({ org }: { org: OrgItem }) {
    const load = useCallback(
        () => apiGet(`/orgs/${org.id}/invitations`, invitationsResponseSchema),
        [org.id],
    );
    const { data, error, reload } = useLoad(load);
    const [email, setEmail] = useState("");
    const [role, setRole] = useState<"member" | "admin">("member");
    const [message, setMessage] = useState("");
    const [failed, setFailed] = useState(false);

    const report = (text: string, bad: boolean) => {
        setMessage(text);
        setFailed(bad);
    };
    const send = async (event: FormEvent) => {
        event.preventDefault();
        const post = () =>
            apiSend(`/orgs/${org.id}/invitations`, created, {
                method: "POST",
                body: { email, role },
            });
        try {
            await (role === "admin" ? withStepUp(post) : post());
            setEmail("");
            report("Invitation sent.", false);
            reload();
        } catch (failure) {
            report(messageOf(failure), true);
        }
    };
    const revoke = async (id: string) => {
        try {
            await apiDo(`/orgs/${org.id}/invitations/${id}`, { method: "DELETE" });
            report("Invitation revoked.", false);
            reload();
        } catch (failure) {
            report(messageOf(failure), true);
        }
    };

    return (
        <Section id="invitations" title="Invitations">
            {error !== "" && <Notice text={error} bad />}
            <ul className="mb-4 flex flex-col gap-2">
                {data?.items.map((item) => (
                    <InvitationRow key={item.id} item={item} onRevoke={() => revoke(item.id)} />
                ))}
            </ul>
            <InviteForm org={org} state={{ email, setEmail, role, setRole }} onSubmit={send} />
            {message !== "" && <Notice text={message} bad={failed} />}
        </Section>
    );
}

function InvitationRow({ item, onRevoke }: { item: InvitationItem; onRevoke: () => void }) {
    return (
        <li className="flex items-center justify-between gap-3 border-b border-line pb-2">
            <span>
                {item.email}
                <span className="ml-2 text-sm text-muted">
                    {item.role} · expires {new Date(item.expires_at).toLocaleDateString()}
                </span>
            </span>
            <button type="button" className={buttonQuiet} onClick={onRevoke}>
                Revoke invitation for {item.email}
            </button>
        </li>
    );
}

interface InviteState {
    readonly email: string;
    readonly setEmail: (value: string) => void;
    readonly role: "member" | "admin";
    readonly setRole: (value: "member" | "admin") => void;
}

function InviteForm({
    org,
    state,
    onSubmit,
}: {
    org: OrgItem;
    state: InviteState;
    onSubmit: (event: FormEvent) => void;
}) {
    return (
        <form onSubmit={onSubmit} className="flex flex-col gap-2">
            <label htmlFor="invite-email">Email address to invite</label>
            <input
                id="invite-email"
                type="email"
                className={input}
                required
                value={state.email}
                onChange={(e) => state.setEmail(e.target.value)}
            />
            {org.role === "owner" && (
                <>
                    <label htmlFor="invite-role">Role</label>
                    <select
                        id="invite-role"
                        className={input}
                        value={state.role}
                        onChange={(e) =>
                            state.setRole(e.target.value === "admin" ? "admin" : "member")
                        }
                    >
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                    </select>
                </>
            )}
            <button type="submit" className={button}>
                Send invitation
            </button>
        </form>
    );
}
