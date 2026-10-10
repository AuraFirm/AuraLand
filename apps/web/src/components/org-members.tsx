"use client";

import { type MemberItem, membersResponseSchema, type OrgItem } from "@aura/contracts/api/orgs";
import { useCallback, useState } from "react";
import { apiDo, apiGet, messageOf } from "../lib/api.ts";
import { withStepUp } from "../lib/passkeys.ts";
import { buttonDanger, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

const ROLES = ["owner", "admin", "member"] as const;

export function OrgMembers({ org }: { org: OrgItem }) {
    const load = useCallback(
        () => apiGet(`/orgs/${org.id}/members`, membersResponseSchema),
        [org.id],
    );
    const { data, error, reload } = useLoad(load);
    const [message, setMessage] = useState("");

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
        <Section id="members" title="Members">
            {error !== "" && <Notice text={error} bad />}
            <ul className="flex flex-col gap-2">
                {data?.items.map((member) => (
                    <MemberListItem
                        key={member.user_id}
                        member={member}
                        myRole={org.role}
                        onRole={(role) =>
                            act(
                                () =>
                                    withStepUp(() =>
                                        apiDo(`/orgs/${org.id}/members/${member.user_id}`, {
                                            method: "PATCH",
                                            body: { role },
                                        }),
                                    ),
                                "Role changed.",
                            )
                        }
                        onRemove={() =>
                            act(
                                () =>
                                    withStepUp(() =>
                                        apiDo(`/orgs/${org.id}/members/${member.user_id}`, {
                                            method: "DELETE",
                                        }),
                                    ),
                                "Member removed.",
                            )
                        }
                    />
                ))}
            </ul>
            {message !== "" && <Notice text={message} />}
        </Section>
    );
}

interface ItemProps {
    readonly member: MemberItem;
    readonly myRole: OrgItem["role"];
    readonly onRole: (role: MemberItem["role"]) => Promise<void>;
    readonly onRemove: () => Promise<void>;
}

function MemberListItem({ member, myRole, onRole, onRemove }: ItemProps) {
    const label = member.display_name ?? member.handle ?? "Member";
    const canChangeRole = myRole === "owner";
    const canRemove = myRole === "owner" || (myRole === "admin" && member.role === "member");
    return (
        <li className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-2">
            <span>
                {label}
                {member.handle !== null && (
                    <span className="ml-2 text-sm text-muted">@{member.handle}</span>
                )}
            </span>
            <span className="flex items-center gap-2">
                {canChangeRole ? (
                    <>
                        <label className="sr-only" htmlFor={`role-${member.user_id}`}>
                            Role of {label}
                        </label>
                        <select
                            id={`role-${member.user_id}`}
                            className={input}
                            value={member.role}
                            onChange={(e) => onRole(roleOf(e.target.value))}
                        >
                            {ROLES.map((role) => (
                                <option key={role} value={role}>
                                    {role}
                                </option>
                            ))}
                        </select>
                    </>
                ) : (
                    <span className="text-muted">{member.role}</span>
                )}
                {canRemove && (
                    <button type="button" className={buttonDanger} onClick={onRemove}>
                        Remove {label}
                    </button>
                )}
            </span>
        </li>
    );
}

function roleOf(value: string): MemberItem["role"] {
    return value === "owner" || value === "admin" ? value : "member";
}
