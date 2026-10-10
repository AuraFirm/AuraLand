// Goal: the task access table, written out. Every role against every task action, plus a stranger.
import type { OrgRole } from "@aura/contracts/identity";
import { describe, expect, it } from "vitest";
import { type TaskAction, taskAccess } from "./access.ts";

const ORG = "018f0000-0000-7000-8000-0000000000aa";
const ELSEWHERE = "018f0000-0000-7000-8000-0000000000bb";

const ROLES: readonly OrgRole[] = ["owner", "admin", "setter", "reviewer", "member"];
// Who may do each action, as the lists of roles that may.
const MAY: Record<TaskAction, readonly OrgRole[]> = {
    read: ROLES,
    write: ["owner", "admin", "setter"],
    review: ["owner", "admin", "reviewer"],
};
const ACTIONS: readonly TaskAction[] = ["read", "write", "review"];

describe("taskAccess", () => {
    for (const action of ACTIONS) {
        for (const role of ROLES) {
            const allowed = MAY[action].includes(role);
            it(`${role} ${allowed ? "may" : "may not"} ${action} tasks`, () => {
                const decision = taskAccess([{ orgId: ORG, role }], ORG, action);
                expect(decision.allowed).toBe(allowed);
            });
        }
        it(`a stranger may not ${action} tasks`, () => {
            const decision = taskAccess([{ orgId: ELSEWHERE, role: "owner" }], ORG, action);
            expect(decision.allowed).toBe(false);
        });
    }

    it("tells a stranger 'not a member' and a member 'insufficient role'", () => {
        expect(taskAccess([], ORG, "read")).toEqual({ allowed: false, reason: "not_member" });
        expect(taskAccess([{ orgId: ORG, role: "member" }], ORG, "write")).toEqual({
            allowed: false,
            reason: "insufficient_role",
        });
    });

    it("looks only at the membership of the organization asked about", () => {
        const memberships: { orgId: string; role: OrgRole }[] = [
            { orgId: ELSEWHERE, role: "owner" },
            { orgId: ORG, role: "member" },
        ];
        expect(taskAccess(memberships, ORG, "write").allowed).toBe(false);
    });
});
