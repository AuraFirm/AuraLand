"use client";

import {
    assignmentCreateRequestSchema,
    assignmentsResponseSchema,
} from "@aura/contracts/api/assignments";
import { membersResponseSchema } from "@aura/contracts/api/orgs";
import { type FormEvent, useCallback, useState } from "react";
import { apiDo, apiGet, apiSend, messageOf } from "../lib/api.ts";
import { button, buttonQuiet, input } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

// Who works on this task, for owners and admins. Setters see only tasks they made or were assigned,
// reviewers only assigned ones; this is where that is decided. The API and PostgreSQL enforce it.
export function TaskAssignments({ taskId, orgId }: { taskId: string; orgId: string }) {
    const loadAssigned = useCallback(
        () => apiGet(`/tasks/${taskId}/assignments`, assignmentsResponseSchema),
        [taskId],
    );
    const loadMembers = useCallback(
        () => apiGet(`/orgs/${orgId}/members`, membersResponseSchema),
        [orgId],
    );
    const assigned = useLoad(loadAssigned);
    const members = useLoad(loadMembers);
    const [message, setMessage] = useState("");
    const staff = members.data?.items.filter(
        (member) => member.role === "setter" || member.role === "reviewer",
    );
    const nameOf = (userId: string) => {
        const member = members.data?.items.find((item) => item.user_id === userId);
        return member?.display_name ?? member?.handle ?? userId;
    };

    const assign = async (userId: string) => {
        try {
            await apiSend(`/tasks/${taskId}/assignments`, assignmentsResponseSchema, {
                method: "POST",
                body: assignmentCreateRequestSchema.parse({ user_id: userId }),
            });
            setMessage("Assigned.");
            assigned.reload();
        } catch (failure) {
            setMessage(messageOf(failure));
        }
    };
    const remove = async (userId: string) => {
        try {
            await apiDo(`/tasks/${taskId}/assignments/${userId}`, { method: "DELETE" });
            setMessage("Removed.");
            assigned.reload();
        } catch (failure) {
            setMessage(messageOf(failure));
        }
    };

    return (
        <Section id="assignments" title="Who works on this task">
            {assigned.error !== "" && <Notice text={assigned.error} bad />}
            {assigned.data?.assignments.length === 0 && <Notice text="Nobody is assigned yet." />}
            <ul className="mb-3 flex flex-col gap-2">
                {assigned.data?.assignments.map((assignment) => (
                    <li key={assignment.user_id} className="flex items-center justify-between">
                        <span>{nameOf(assignment.user_id)}</span>
                        <button
                            type="button"
                            className={buttonQuiet}
                            onClick={() => remove(assignment.user_id)}
                        >
                            {`Remove ${nameOf(assignment.user_id)}`}
                        </button>
                    </li>
                ))}
            </ul>
            <AssignForm staff={staff ?? []} onAssigned={assign} />
            {message !== "" && <Notice text={message} />}
        </Section>
    );
}

interface Candidate {
    readonly user_id: string;
    readonly display_name: string | null;
    readonly handle: string | null;
    readonly role: string;
}

function AssignForm({
    staff,
    onAssigned,
}: {
    staff: readonly Candidate[];
    onAssigned: (userId: string) => Promise<void>;
}) {
    const [choice, setChoice] = useState("");
    const submit = (event: FormEvent) => {
        event.preventDefault();
        void onAssigned(choice);
    };
    return (
        <form onSubmit={submit} className="flex flex-col gap-2">
            <label htmlFor="assignee">Person to assign</label>
            <select
                id="assignee"
                className={input}
                required
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
            >
                <option value="">Choose a setter or reviewer</option>
                {staff.map((member) => (
                    <option key={member.user_id} value={member.user_id}>
                        {`${member.display_name ?? member.handle ?? member.user_id} (${member.role})`}
                    </option>
                ))}
            </select>
            <button type="submit" className={button}>
                Assign
            </button>
        </form>
    );
}
