import type { OrgRole } from "@aura/contracts/identity";

// Deny by default: every action is listed here with the rule that allows it, and anything else is
// refused. The same rules are enforced again by PostgreSQL row-level security, so a mistake in one
// layer does not become a hole (Stage 1 plan section 7).

export interface OrgMembership {
    readonly orgId: string;
    readonly role: OrgRole;
}

// The signed-in person as the rules see them.
export interface Subject {
    readonly userId: string;
    readonly orgs: readonly OrgMembership[];
}

export type OrgAction =
    | { readonly kind: "org.read"; readonly orgId: string }
    | { readonly kind: "org.update"; readonly orgId: string }
    | { readonly kind: "members.read"; readonly orgId: string }
    | {
          readonly kind: "members.change_role";
          readonly orgId: string;
          readonly targetUserId: string;
          readonly targetRole: OrgRole;
          readonly newRole: OrgRole;
      }
    | {
          readonly kind: "members.remove";
          readonly orgId: string;
          readonly targetUserId: string;
          readonly targetRole: OrgRole;
      };

export type Decision =
    | { readonly allowed: true }
    | { readonly allowed: false; readonly reason: "not_member" | "insufficient_role" };

const ALLOWED: Decision = { allowed: true };
const NOT_MEMBER: Decision = { allowed: false, reason: "not_member" };
const INSUFFICIENT: Decision = { allowed: false, reason: "insufficient_role" };

export function roleIn(subject: Subject, orgId: string): OrgRole | null {
    return subject.orgs.find((membership) => membership.orgId === orgId)?.role ?? null;
}

export function authorize(subject: Subject, action: OrgAction): Decision {
    const role = roleIn(subject, action.orgId);
    // Someone outside the organization learns nothing about it, not even that it exists.
    if (role === null) return NOT_MEMBER;
    switch (action.kind) {
        case "org.read":
        case "members.read":
            return ALLOWED;
        case "org.update":
            return role === "owner" || role === "admin" ? ALLOWED : INSUFFICIENT;
        case "members.change_role":
            return role === "owner" ? ALLOWED : INSUFFICIENT;
        case "members.remove":
            return canRemove(subject.userId, role, action);
        default:
            return INSUFFICIENT;
    }
}

// Anyone may leave; owners remove anyone; admins remove plain members.
function canRemove(
    actorId: string,
    role: OrgRole,
    action: { readonly targetUserId: string; readonly targetRole: OrgRole },
): Decision {
    if (action.targetUserId === actorId) return ALLOWED;
    if (role === "owner") return ALLOWED;
    return role === "admin" && action.targetRole === "member" ? ALLOWED : INSUFFICIENT;
}
