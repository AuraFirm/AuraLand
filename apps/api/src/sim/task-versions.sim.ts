import { assert } from "@aura/contracts/assert";
import type { VersionState } from "@aura/contracts/tasks";
import { hasFreshStepUp } from "../modules/identity/authorize.ts";
import { STEP_UP_FRESH_S } from "../modules/identity/limits.ts";
import {
    type Actor,
    decide,
    isFrozen,
    type TaskRole,
    VERSION_ACTIONS,
    type VersionAction,
} from "../modules/tasks/rules.ts";
import type { Scenario } from "./runner.ts";
import type { World } from "./world.ts";

// Goal: drive task versions through random actions by random people at random times and compare
// every decision with an independent model written as plain lookup tables, not as the production
// rule objects. Invariants: a version moves only along documented edges; a frozen version (released
// retired, rejected) never moves except released -> retired; a release always has an approval, a
// different person than the creator, a fresh passkey check and the right waiver flag; a task never
// has two released versions; a creator never approves or releases their own version.

const MS = 1000;
const PEOPLE: readonly { readonly id: string; readonly role: TaskRole }[] = [
    { id: "u-owner", role: "owner" },
    { id: "u-admin", role: "admin" },
    { id: "u-setter", role: "setter" },
    { id: "u-setter2", role: "setter" },
    { id: "u-reviewer", role: "reviewer" },
    { id: "u-member", role: "member" },
];
// Just either side of the fresh-check window.
const ADVANCES_S = [1, 60, STEP_UP_FRESH_S - 1, STEP_UP_FRESH_S, STEP_UP_FRESH_S + 1, 3600];
const VERSIONS_MAX = 24;
const TASKS = 3;

// The model: for each action, where it starts and ends, who may do it, and extra needs. Written as
// parallel tables on purpose, so a slip in the production table does not repeat here.
const MODEL_EDGE: Readonly<Record<VersionAction, readonly [readonly string[], string]>> = {
    finalize: [["draft"], "uploaded"],
    submit: [["uploaded"], "in_review"],
    request_changes: [["in_review"], "uploaded"],
    reject: [["in_review"], "rejected"],
    abandon: [["draft", "uploaded"], "rejected"],
    begin_validation: [["in_review"], "validating"],
    validation_passed: [["validating"], "validated"],
    validation_failed: [["validating"], "uploaded"],
    release: [["validated"], "released"],
    release_with_waiver: [["in_review"], "released"],
    retire: [["released"], "retired"],
};
const MODEL_WRITER = new Set(["finalize", "submit", "abandon"]);
const MODEL_SYSTEM = new Set(["begin_validation", "validation_passed", "validation_failed"]);
const MODEL_NEEDS_STEP_UP = new Set(["release", "release_with_waiver", "retire"]);
const MODEL_NEEDS_OTHER_PERSON = new Set([
    "request_changes",
    "reject",
    "release",
    "release_with_waiver",
]);

interface Version {
    readonly id: number;
    readonly task: number;
    readonly creator: string;
    state: VersionState;
    approved: boolean;
    waived: boolean;
    releasedBy: string | null;
}

interface Harness {
    readonly world: World;
    readonly versions: Version[];
    readonly stepUpAtMs: Map<string, number>;
}

function modelAllows(
    action: VersionAction,
    actor: Actor,
    version: Version,
    fresh: boolean,
): boolean {
    const edge = MODEL_EDGE[action];
    if (MODEL_SYSTEM.has(action)) {
        if (actor.kind !== "system") return false;
    } else if (actor.kind !== "person") {
        return false;
    } else if (MODEL_WRITER.has(action)) {
        if (!["owner", "admin", "setter"].includes(actor.role)) return false;
    } else if (!["owner", "admin", "reviewer"].includes(actor.role)) {
        return false;
    }
    if (
        MODEL_NEEDS_OTHER_PERSON.has(action) &&
        actor.kind === "person" &&
        actor.userId === version.creator
    ) {
        return false;
    }
    if (!edge[0].includes(version.state)) return false;
    if ((action === "release" || action === "release_with_waiver") && !version.approved)
        return false;
    return !MODEL_NEEDS_STEP_UP.has(action) || fresh;
}

function pickActor(h: Harness, version: Version, action: VersionAction): Actor {
    // The sandbox's own moves are mostly tried by the system itself, and now and then by anyone.
    const systemRolls = MODEL_SYSTEM.has(action) ? 3 : 1; // out of 4 for its own moves, 1 in 8 else
    if (h.world.rng.nextInt(MODEL_SYSTEM.has(action) ? 4 : 8) < systemRolls) {
        return { kind: "system" };
    }
    // One roll in three is the version's own creator, the person separation of duties is about.
    const own =
        h.world.rng.nextInt(3) === 0 ? PEOPLE.find((p) => p.id === version.creator) : undefined;
    const person = own ?? PEOPLE[h.world.rng.nextInt(PEOPLE.length)];
    assert(person !== undefined, "the person list is not empty");
    return { kind: "person", userId: person.id, role: person.role };
}

function opCreate(h: Harness): void {
    if (h.versions.length >= VERSIONS_MAX) return;
    const writers = PEOPLE.filter((p) => ["owner", "admin", "setter"].includes(p.role));
    const creator = writers[h.world.rng.nextInt(writers.length)];
    assert(creator !== undefined, "there are writers");
    h.versions.push({
        id: h.versions.length,
        task: h.world.rng.nextInt(TASKS),
        creator: creator.id,
        state: "draft",
        approved: false,
        waived: false,
        releasedBy: null,
    });
}

// A review while in review: approvals by the creator are refused by the database, so the model never
// records one. Leaving review clears the approval, as the database's stint rule does.
function opReview(h: Harness): void {
    const version = h.versions[h.world.rng.nextInt(Math.max(h.versions.length, 1))];
    const reviewer = PEOPLE[h.world.rng.nextInt(PEOPLE.length)];
    if (version === undefined || reviewer === undefined) return;
    const mayReview = ["owner", "admin", "reviewer"].includes(reviewer.role);
    if (version.state === "in_review" && mayReview && reviewer.id !== version.creator) {
        version.approved = true;
    }
}

function opStepUp(h: Harness): void {
    const person = PEOPLE[h.world.rng.nextInt(PEOPLE.length)];
    if (person !== undefined) h.stepUpAtMs.set(person.id, h.world.clock.nowUnixMs());
}

// Three picks in four choose an action that starts in the version's current state, so the run
// reaches the late states (validated, released, retired) instead of mostly bouncing off early ones.
function pickAction(h: Harness, version: Version): VersionAction {
    const fitting = VERSION_ACTIONS.filter((a) => MODEL_EDGE[a][0].includes(version.state));
    const pool = h.world.rng.nextInt(4) > 0 && fitting.length > 0 ? fitting : VERSION_ACTIONS;
    const action = pool[h.world.rng.nextInt(pool.length)];
    assert(action !== undefined, "the action list is not empty");
    return action;
}

function opAct(h: Harness): void {
    const version = h.versions[h.world.rng.nextInt(Math.max(h.versions.length, 1))];
    if (version === undefined) return;
    const action = pickAction(h, version);
    const actor = pickActor(h, version, action);
    const nowMs = h.world.clock.nowUnixMs();
    const stepUp = actor.kind === "person" ? (h.stepUpAtMs.get(actor.userId) ?? null) : null;
    const fresh = hasFreshStepUp(stepUp, nowMs);
    const outcome = decide(action, actor, {
        state: version.state,
        creatorId: version.creator,
        hasApproval: version.approved,
        stepUpFresh: fresh,
    });
    const expected = modelAllows(action, actor, version, fresh);
    assert(
        outcome.ok === expected,
        `${action} by ${actor.kind} on ${version.state}: model disagrees`,
    );
    if (!outcome.ok) return;
    assert(outcome.next === MODEL_EDGE[action][1], "the move ends where the model says");
    apply(h, version, action, outcome.next, outcome.waived, actor);
}

function apply(
    h: Harness,
    version: Version,
    action: VersionAction,
    next: VersionState,
    waived: boolean,
    actor: Actor,
): void {
    if (next === "released") {
        // Releasing a newer version retires the one before it, in the same step (one current version).
        for (const other of h.versions) {
            if (other.task === version.task && other.state === "released") other.state = "retired";
        }
        version.waived = waived;
        version.releasedBy = actor.kind === "person" ? actor.userId : null;
    }
    assert(
        waived === (action === "release_with_waiver"),
        "waived exactly when validation is skipped",
    );
    version.state = next;
    // Leaving review for editing or the end clears the approval; the database's stint rule does too.
    if (next === "uploaded" || next === "rejected") version.approved = false;
}

function check(h: Harness): void {
    const released = new Map<number, number>();
    for (const version of h.versions) {
        if (version.state === "released") {
            released.set(version.task, (released.get(version.task) ?? 0) + 1);
            assert(version.approved, "a released version was approved");
            assert(version.releasedBy !== null, "a released version has a releaser");
            assert(version.releasedBy !== version.creator, "nobody releases their own version");
        }
        if (isFrozen(version.state) && version.state !== "released") {
            assert(
                !version.waived || version.state === "retired",
                "only released versions are waived",
            );
        }
    }
    for (const count of released.values())
        assert(count <= 1, "a task has at most one released version");
}

export function taskVersionScenario(): Scenario {
    return {
        name: "task-versions",
        stepsMax: 400,
        start(world: World) {
            const h: Harness = { world, versions: [], stepUpAtMs: new Map() };
            const ops = [
                opCreate,
                opCreate,
                opReview,
                opReview,
                opStepUp,
                opAct,
                opAct,
                opAct,
                opAct,
                opAct,
                opAct,
            ];
            return {
                step() {
                    const roll = h.world.rng.nextInt(20);
                    if (roll === 0) {
                        h.world.clock.advance(
                            (ADVANCES_S[h.world.rng.nextInt(ADVANCES_S.length)] ?? 1) * MS,
                        );
                        return;
                    }
                    ops[h.world.rng.nextInt(ops.length)]?.(h);
                },
                check: () => check(h),
            };
        },
    };
}
