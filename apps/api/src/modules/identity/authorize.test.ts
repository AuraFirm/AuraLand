// Goal: the whole authorization table, written out. Every role is tried against every organization
// action, including the edges (removing yourself, removing someone of higher rank, a stranger).
import type { OrgRole } from "@aura/contracts/identity";
import { describe, expect, it } from "vitest";
import { authorize, type OrgAction, roleIn, type Subject } from "./authorize.ts";

const ORG = "018f0000-0000-7000-8000-0000000000aa";
const OTHER_ORG = "018f0000-0000-7000-8000-0000000000bb";
const ME = "018f0000-0000-7000-8000-000000000001";
const THEM = "018f0000-0000-7000-8000-000000000002";
const subject = (role: OrgRole | null): Subject => ({
    userId: ME,
    orgs: role === null ? [{ orgId: OTHER_ORG, role: "owner" }] : [{ orgId: ORG, role }],
});

type Expectation = Record<"owner" | "admin" | "member" | "stranger", boolean>;
const ROLES: Array<keyof Expectation> = ["owner", "admin", "member", "stranger"];

const table: Array<[string, OrgAction, Expectation]> = [
    [
        "read the organization",
        { kind: "org.read", orgId: ORG },
        { owner: true, admin: true, member: true, stranger: false },
    ],
    [
        "list members",
        { kind: "members.read", orgId: ORG },
        { owner: true, admin: true, member: true, stranger: false },
    ],
    [
        "rename",
        { kind: "org.update", orgId: ORG },
        { owner: true, admin: true, member: false, stranger: false },
    ],
    [
        "change a member's role",
        {
            kind: "members.change_role",
            orgId: ORG,
            targetUserId: THEM,
            targetRole: "member",
            newRole: "admin",
        },
        { owner: true, admin: false, member: false, stranger: false },
    ],
    [
        "remove a member",
        { kind: "members.remove", orgId: ORG, targetUserId: THEM, targetRole: "member" },
        { owner: true, admin: true, member: false, stranger: false },
    ],
    [
        "remove an admin",
        { kind: "members.remove", orgId: ORG, targetUserId: THEM, targetRole: "admin" },
        { owner: true, admin: false, member: false, stranger: false },
    ],
    [
        "remove an owner",
        { kind: "members.remove", orgId: ORG, targetUserId: THEM, targetRole: "owner" },
        { owner: true, admin: false, member: false, stranger: false },
    ],
    [
        "leave",
        { kind: "members.remove", orgId: ORG, targetUserId: ME, targetRole: "member" },
        { owner: true, admin: true, member: true, stranger: false },
    ],
];

describe("authorize", () => {
    for (const [name, action, expected] of table) {
        for (const role of ROLES) {
            it(`${role} ${expected[role] ? "may" : "may not"} ${name}`, () => {
                const decision = authorize(subject(role === "stranger" ? null : role), action);
                expect(decision.allowed).toBe(expected[role]);
            });
        }
    }

    it("tells a stranger 'not a member' for everything, so existence is not revealed", () => {
        for (const [, action] of table) {
            expect(authorize(subject(null), action)).toEqual({
                allowed: false,
                reason: "not_member",
            });
        }
    });

    it("tells a member who lacks the role 'insufficient role'", () => {
        expect(authorize(subject("member"), { kind: "org.update", orgId: ORG })).toEqual({
            allowed: false,
            reason: "insufficient_role",
        });
    });

    it("finds a role only in the named organization", () => {
        expect(roleIn(subject("admin"), ORG)).toBe("admin");
        expect(roleIn(subject("admin"), OTHER_ORG)).toBeNull();
    });
});
