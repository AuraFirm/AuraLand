// Goal: the version state machine allows exactly the documented moves, checks who is acting before
// what state the version is in, and asks for a fresh passkey check only for a move that would
// otherwise succeed. The simulation covers random sequences; these cases pin each rule by name.
import { VERSION_STATES } from "@aura/contracts/tasks";
import { describe, expect, it } from "vitest";
import {
    type Actor,
    ALLOWED_PAIRS,
    decide,
    type Facts,
    isFrozen,
    VERSION_ACTIONS,
} from "./rules.ts";

const person = (
    role: "owner" | "admin" | "setter" | "reviewer" | "member",
    userId = "u-1",
): Actor => ({
    kind: "person",
    userId,
    role,
});
const SYSTEM: Actor = { kind: "system" };
const facts = (overrides: Partial<Facts> = {}): Facts => ({
    state: "in_review",
    creatorId: "u-creator",
    hasApproval: true,
    stepUpFresh: true,
    ...overrides,
});

describe("allowed moves", () => {
    it("lists exactly the pairs the database trigger allows", () => {
        expect([...ALLOWED_PAIRS].sort()).toEqual(
            [
                "draft>uploaded",
                "uploaded>in_review",
                "in_review>uploaded",
                "in_review>rejected",
                "draft>rejected",
                "uploaded>rejected",
                "in_review>validating",
                "validating>validated",
                "validating>uploaded",
                "validated>released",
                "in_review>released",
                "released>retired",
            ].sort(),
        );
    });

    it("never leaves a frozen state, apart from retiring a release", () => {
        for (const pair of ALLOWED_PAIRS) {
            const [from] = pair.split(">");
            if (from === "released") expect(pair).toBe("released>retired");
            if (from === "retired" || from === "rejected")
                throw new Error(`${pair} leaves a final state`);
        }
        expect(VERSION_STATES.filter(isFrozen).sort()).toEqual(["rejected", "released", "retired"]);
    });
});

describe("who may act", () => {
    it("lets writers finalize and submit, and nobody else", () => {
        for (const role of ["owner", "admin", "setter"] as const) {
            expect(decide("finalize", person(role), facts({ state: "draft" })).ok).toBe(true);
            expect(decide("submit", person(role), facts({ state: "uploaded" })).ok).toBe(true);
        }
        for (const role of ["reviewer", "member"] as const) {
            expect(decide("submit", person(role), facts({ state: "uploaded" }))).toEqual({
                ok: false,
                refusal: "wrong_role",
            });
        }
    });

    it("keeps the sandbox's moves for the system", () => {
        expect(decide("begin_validation", SYSTEM, facts()).ok).toBe(true);
        expect(decide("begin_validation", person("owner"), facts())).toEqual({
            ok: false,
            refusal: "wrong_role",
        });
        // And the system cannot do a person's work.
        expect(decide("submit", SYSTEM, facts({ state: "uploaded" }))).toEqual({
            ok: false,
            refusal: "wrong_role",
        });
    });

    it("checks the role before the state, so strangers learn nothing about the version", () => {
        expect(decide("release", person("member"), facts({ state: "draft" }))).toEqual({
            ok: false,
            refusal: "wrong_role",
        });
    });
});

describe("separation of duties", () => {
    it("never lets a creator reject, ask for changes on, or release their own version", () => {
        const own = person("owner", "u-creator");
        for (const action of ["reject", "request_changes", "release_with_waiver"] as const) {
            expect(decide(action, own, facts())).toEqual({ ok: false, refusal: "own_version" });
        }
        expect(decide("release", own, facts({ state: "validated" }))).toEqual({
            ok: false,
            refusal: "own_version",
        });
    });

    it("lets a creator abandon their own draft", () => {
        expect(decide("abandon", person("setter", "u-creator"), facts({ state: "draft" })).ok).toBe(
            true,
        );
    });
});

describe("release", () => {
    const reviewer = person("reviewer");

    it("needs an approval, then a fresh passkey check, in that order", () => {
        const noApproval = facts({ hasApproval: false, stepUpFresh: false });
        expect(decide("release_with_waiver", reviewer, noApproval)).toEqual({
            ok: false,
            refusal: "needs_approval",
        });
        expect(decide("release_with_waiver", reviewer, facts({ stepUpFresh: false }))).toEqual({
            ok: false,
            refusal: "needs_step_up",
        });
    });

    it("marks a release waived exactly when validation was skipped", () => {
        expect(decide("release_with_waiver", reviewer, facts())).toEqual({
            ok: true,
            next: "released",
            waived: true,
        });
        expect(decide("release", reviewer, facts({ state: "validated" }))).toEqual({
            ok: true,
            next: "released",
            waived: false,
        });
    });

    it("refuses a release from any other state", () => {
        for (const state of VERSION_STATES) {
            const waiver = decide("release_with_waiver", reviewer, facts({ state }));
            const normal = decide("release", reviewer, facts({ state }));
            expect(waiver.ok).toBe(state === "in_review");
            expect(normal.ok).toBe(state === "validated");
        }
    });

    it("needs a fresh check to retire, and nothing leaves retired or rejected", () => {
        expect(
            decide("retire", reviewer, facts({ state: "released", stepUpFresh: false })),
        ).toEqual({
            ok: false,
            refusal: "needs_step_up",
        });
        for (const action of VERSION_ACTIONS) {
            for (const state of ["retired", "rejected"] as const) {
                expect(decide(action, person("owner"), facts({ state })).ok).toBe(false);
                expect(decide(action, SYSTEM, facts({ state })).ok).toBe(false);
            }
        }
    });
});
