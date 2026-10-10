import { assert } from "@aura/contracts/assert";
import type { VersionState } from "@aura/contracts/tasks";

// The task-version state machine. Pure: no I/O, no clock, so every rule can be simulated and tested.
// The database enforces the same pairs with a trigger (migration 0012); `ALLOWED_PAIRS` mirrors that
// list and a database test compares the two, so neither layer can drift alone.

export type TaskRole = "owner" | "admin" | "setter" | "reviewer" | "member";

// What each action does to the state is in RULES below; the comments here are the one-line summary.
// finalize: draft -> uploaded (the bundle's size and hash were verified). submit: uploaded ->
// in_review. request_changes: in_review -> uploaded. reject: in_review -> rejected. abandon: draft or
// uploaded -> rejected, by the writers. begin_validation, validation_passed, validation_failed: the
// sandbox's moves (Stage 3). release: validated -> released. release_with_waiver: in_review ->
// released, skipping validation. retire: released -> retired.
export const VERSION_ACTIONS = [
    "finalize",
    "submit",
    "request_changes",
    "reject",
    "abandon",
    "begin_validation",
    "validation_passed",
    "validation_failed",
    "release",
    "release_with_waiver",
    "retire",
] as const;
export type VersionAction = (typeof VERSION_ACTIONS)[number];

// "writers" edit and submit; "reviewers" decide and release. Owners and admins are both.
const WRITER_ROLES: readonly TaskRole[] = ["owner", "admin", "setter"];
const REVIEWER_ROLES: readonly TaskRole[] = ["owner", "admin", "reviewer"];

interface Rule {
    readonly from: readonly VersionState[];
    readonly to: VersionState;
    // Who may do it: a set of roles, or the system itself (the sandbox, never a person).
    readonly by: readonly TaskRole[] | "system";
    // A person other than the version's creator (separation of duties).
    readonly notCreator?: true;
    // An approving review must exist.
    readonly needsApproval?: true;
    // A passkey check within the last 15 minutes (ADR 0018).
    readonly needsStepUp?: true;
    readonly waived?: boolean;
}

const RULES: Readonly<Record<VersionAction, Rule>> = {
    finalize: { from: ["draft"], to: "uploaded", by: WRITER_ROLES },
    submit: { from: ["uploaded"], to: "in_review", by: WRITER_ROLES },
    request_changes: {
        from: ["in_review"],
        to: "uploaded",
        by: REVIEWER_ROLES,
        notCreator: true,
    },
    reject: { from: ["in_review"], to: "rejected", by: REVIEWER_ROLES, notCreator: true },
    abandon: { from: ["draft", "uploaded"], to: "rejected", by: WRITER_ROLES },
    begin_validation: { from: ["in_review"], to: "validating", by: "system" },
    validation_passed: { from: ["validating"], to: "validated", by: "system" },
    validation_failed: { from: ["validating"], to: "uploaded", by: "system" },
    release: {
        from: ["validated"],
        to: "released",
        by: REVIEWER_ROLES,
        notCreator: true,
        needsApproval: true,
        needsStepUp: true,
        waived: false,
    },
    release_with_waiver: {
        from: ["in_review"],
        to: "released",
        by: REVIEWER_ROLES,
        notCreator: true,
        needsApproval: true,
        needsStepUp: true,
        waived: true,
    },
    retire: { from: ["released"], to: "retired", by: REVIEWER_ROLES, needsStepUp: true },
};

// Every allowed (from, to) pair, derived from the rules above. Compared with the SQL trigger's list.
export const ALLOWED_PAIRS: readonly string[] = VERSION_ACTIONS.flatMap((action) =>
    RULES[action].from.map((from) => `${from}>${RULES[action].to}`),
);

export type Actor =
    | { readonly kind: "system" }
    | { readonly kind: "person"; readonly userId: string; readonly role: TaskRole };

export interface Facts {
    readonly state: VersionState;
    readonly creatorId: string;
    readonly hasApproval: boolean;
    readonly stepUpFresh: boolean;
}

export type Refusal =
    | "wrong_state" // the action does not apply to this state: conflict
    | "wrong_role" // the actor's role may not do it: forbidden
    | "own_version" // separation of duties: forbidden
    | "needs_approval" // no approving review yet: conflict
    | "needs_step_up"; // a fresh passkey check is required: step_up_required

export type Outcome =
    | { readonly ok: true; readonly next: VersionState; readonly waived: boolean }
    | { readonly ok: false; readonly refusal: Refusal };

const refuse = (refusal: Refusal): Outcome => ({ ok: false, refusal });

// Decides one action. Order matters and is part of the contract: who you are is checked before what
// state the version is in, so a person without the role learns nothing about the version's state;
// the step-up check comes last so a person is only asked to prove themselves for a move that would
// otherwise succeed.
export function decide(action: VersionAction, actor: Actor, facts: Facts): Outcome {
    const rule = RULES[action];
    assert(facts.creatorId.length > 0, "a version always has a creator");
    if (rule.by === "system") {
        if (actor.kind !== "system") return refuse("wrong_role");
    } else if (actor.kind !== "person" || !rule.by.includes(actor.role)) {
        return refuse("wrong_role");
    }
    if (rule.notCreator === true && actor.kind === "person" && actor.userId === facts.creatorId) {
        return refuse("own_version");
    }
    if (!rule.from.includes(facts.state)) return refuse("wrong_state");
    if (rule.needsApproval === true && !facts.hasApproval) return refuse("needs_approval");
    if (rule.needsStepUp === true && !facts.stepUpFresh) return refuse("needs_step_up");
    return { ok: true, next: rule.to, waived: rule.waived ?? false };
}

// Terminal states accept nothing further, which `decide` already guarantees; this names them for the
// screens and for the immutability checks.
export function isFrozen(state: VersionState): boolean {
    return state === "released" || state === "retired" || state === "rejected";
}
