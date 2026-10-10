import type { OrgRole } from "@aura/contracts/identity";

// Who may do what with tasks, by organization role. Deny by default; row-level security repeats the
// reading and writing rules in PostgreSQL. Kept inside this module so tasks do not depend on the
// identity module: the caller's memberships arrive on the request actor.

export interface Membership {
    readonly orgId: string;
    readonly role: OrgRole;
}

export type TaskAction = "read" | "write" | "review";

export type Access =
    | { readonly allowed: true }
    // "not_member" is answered with 404 so outsiders learn nothing; "insufficient_role" with 403.
    | { readonly allowed: false; readonly reason: "not_member" | "insufficient_role" };

const ALLOWED: Access = { allowed: true };
const NOT_MEMBER: Access = { allowed: false, reason: "not_member" };
const INSUFFICIENT: Access = { allowed: false, reason: "insufficient_role" };

// Writers make and edit tasks and versions; reviewers decide on them; owners and admins do both.
// Reading is open to every member here; which tasks a plain member actually sees is decided by
// visibility, in the database.
const WRITERS: readonly OrgRole[] = ["owner", "admin", "setter"];
const REVIEWERS: readonly OrgRole[] = ["owner", "admin", "reviewer"];

export function roleIn(memberships: readonly Membership[], orgId: string): OrgRole | null {
    return memberships.find((membership) => membership.orgId === orgId)?.role ?? null;
}

export function taskAccess(
    memberships: readonly Membership[],
    orgId: string,
    action: TaskAction,
): Access {
    const role = roleIn(memberships, orgId);
    if (role === null) return NOT_MEMBER;
    switch (action) {
        case "read":
            return ALLOWED;
        case "write":
            return WRITERS.includes(role) ? ALLOWED : INSUFFICIENT;
        case "review":
            return REVIEWERS.includes(role) ? ALLOWED : INSUFFICIENT;
        default:
            return INSUFFICIENT;
    }
}
