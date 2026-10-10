import { releaseRequestSchema, reviewRequestSchema } from "@aura/contracts/api/task-versions";
import { appendAudit } from "@aura/db/audit";
import { CHECK_VIOLATION, postgresErrorCode, UNIQUE_VIOLATION } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { hasFreshStepUp } from "../../platform/step-up.ts";
import { roleIn } from "./access.ts";
import { caller, invalid, notFound, readJson, unauthenticated } from "./route-support.ts";
import {
    type Actor,
    decide,
    type Facts,
    type Outcome,
    type Refusal,
    type VersionAction,
} from "./rules.ts";
import {
    getVersion,
    hasApproval,
    insertReview,
    moveState,
    otherReleasedVersion,
    recordRelease,
    type VersionRow,
} from "./version-queries.ts";
import { versionAudit, versionBody, versionIdParam } from "./version-routes.ts";

export interface ReviewRouteDeps {
    readonly clock: Clock;
}

// Moves a version along the state machine: submit, review, release, retire, abandon. Every move is
// decided by the pure rules in rules.ts from the caller's role, the version's state and three facts
// (its creator, an approval in this review stint, a fresh passkey check), then applied as one
// guarded SQL statement, so two people acting at once cannot both win.
export function reviewRoutes(deps: ReviewRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/task-versions/:id/submit-review", (c) => handleSimple(c, deps, "submit"));
    routes.post("/task-versions/:id/abandon", (c) => handleSimple(c, deps, "abandon"));
    routes.post("/task-versions/:id/retire", (c) => handleSimple(c, deps, "retire"));
    routes.post("/task-versions/:id/review", (c) => handleReview(c, deps));
    routes.post("/task-versions/:id/release", (c) => handleRelease(c, deps));
    return routes;
}

const REFUSALS: Record<Refusal, (c: Context<AppEnv>) => Response> = {
    wrong_state: (c) => problemResponse(c, "conflict", "This version is not in the right state"),
    wrong_role: (c) => problemResponse(c, "forbidden", "Forbidden"),
    own_version: (c) =>
        problemResponse(
            c,
            "forbidden",
            "Forbidden",
            "Nobody reviews or releases their own version",
        ),
    needs_approval: (c) => problemResponse(c, "conflict", "An approving review is needed first"),
    needs_step_up: (c) =>
        problemResponse(c, "step_up_required", "Confirm with your passkey to continue"),
};

function actorFor(c: Context<AppEnv>, orgId: string): Actor | null {
    const who = caller(c);
    const role = who === null ? null : roleIn(who.orgs, orgId);
    return who === null || role === null ? null : { kind: "person", userId: who.userId, role };
}

async function factsFor(
    c: Context<AppEnv>,
    deps: ReviewRouteDeps,
    row: VersionRow,
): Promise<Facts> {
    const actor = c.get("actor");
    const stepUpAtMs = actor.kind === "user" ? actor.stepUpAtMs : null;
    return {
        state: row.state,
        creatorId: row.created_by,
        hasApproval: row.state === "in_review" ? await hasApproval(c.get("tx"), row.id) : false,
        stepUpFresh: hasFreshStepUp(stepUpAtMs, deps.clock.nowUnixMs()),
    };
}

interface Loaded {
    readonly row: VersionRow;
    readonly actor: Actor;
}

// The version as the caller sees it, and who the caller is in its organization. A version the caller
// cannot see, or an organization they do not belong to, is a plain 404.
async function load(c: Context<AppEnv>): Promise<Loaded | Response> {
    if (caller(c) === null) return unauthenticated(c);
    const versionId = versionIdParam(c);
    if (versionId === null) return invalid(c);
    const row = await getVersion(c.get("tx"), versionId);
    const actor = row === null ? null : actorFor(c, row.org_id);
    return row === null || actor === null ? notFound(c) : { row, actor };
}

const isResponse = (value: Loaded | Response): value is Response => value instanceof Response;

function refusalOf(outcome: Outcome, c: Context<AppEnv>): Response | null {
    return outcome.ok ? null : REFUSALS[outcome.refusal](c);
}

const raced = (c: Context<AppEnv>) =>
    problemResponse(c, "conflict", "Someone else changed this version first");

async function respond(c: Context<AppEnv>, versionId: string) {
    const updated = await getVersion(c.get("tx"), versionId);
    if (updated === null) throw new Error("the version is visible to the person who moved it");
    return c.json(versionBody(updated));
}

const AUDIT_ACTION: Partial<Record<VersionAction, string>> = {
    submit: "task_version.submitted",
    abandon: "task_version.abandoned",
    retire: "task_version.retired",
};

async function handleSimple(c: Context<AppEnv>, deps: ReviewRouteDeps, action: VersionAction) {
    const loaded = await load(c);
    if (isResponse(loaded)) return loaded;
    const { row, actor } = loaded;
    const outcome = decide(action, actor, await factsFor(c, deps, row));
    const refused = refusalOf(outcome, c);
    if (refused !== null) return refused;
    if (!outcome.ok) throw new Error("unreachable: refusals were returned above");
    if (action === "submit" && (row.spec === null || row.statement === null)) {
        return problemResponse(c, "conflict", "Add a statement and a spec before review");
    }
    const tx = c.get("tx");
    if (!(await moveState(tx, row.id, row.state, outcome.next))) return raced(c);
    if (actor.kind !== "person") throw new Error("only people reach the simple moves");
    await appendAudit(
        tx,
        versionAudit(actor.userId, row, AUDIT_ACTION[action] ?? "task_version.moved"),
    );
    return respond(c, row.id);
}

async function handleReview(c: Context<AppEnv>, deps: ReviewRouteDeps) {
    const loaded = await load(c);
    if (isResponse(loaded)) return loaded;
    const body = reviewRequestSchema.safeParse(await readJson(c));
    if (!body.success) return invalid(c);
    const { row, actor } = loaded;
    // An approval records a decision and leaves the version in review; the other two also move it.
    const action: VersionAction | null =
        body.data.outcome === "changes_requested"
            ? "request_changes"
            : body.data.outcome === "rejected"
              ? "reject"
              : null;
    const facts = await factsFor(c, deps, row);
    const outcome = action === null ? approvalOutcome(actor, facts) : decide(action, actor, facts);
    const refused = refusalOf(outcome, c);
    if (refused !== null) return refused;
    if (!outcome.ok || actor.kind !== "person")
        throw new Error("unreachable: refusals were returned above");
    const tx = c.get("tx");
    await insertReview(tx, {
        orgId: row.org_id,
        versionId: row.id,
        reviewerId: actor.userId,
        outcome: body.data.outcome,
        comment: body.data.comment ?? null,
    });
    if (action !== null && !(await moveState(tx, row.id, row.state, outcome.next))) return raced(c);
    await appendAudit(
        tx,
        versionAudit(actor.userId, row, "task_version.reviewed", { outcome: body.data.outcome }),
    );
    return respond(c, row.id);
}

// Approving is not a state change, so the machine has no action for it; the same checks apply: a
// reviewing role, someone other than the creator, and a version that is in review.
function approvalOutcome(actor: Actor, facts: Facts): Outcome {
    const probe = decide("request_changes", actor, facts);
    return probe.ok ? { ok: true, next: facts.state, waived: false } : probe;
}

async function handleRelease(c: Context<AppEnv>, deps: ReviewRouteDeps) {
    const loaded = await load(c);
    if (isResponse(loaded)) return loaded;
    const body = releaseRequestSchema.safeParse(await readJson(c));
    if (!body.success) return invalid(c);
    const { row, actor } = loaded;
    const action: VersionAction = row.state === "validated" ? "release" : "release_with_waiver";
    const outcome = decide(action, actor, await factsFor(c, deps, row));
    const refused = refusalOf(outcome, c);
    if (refused !== null) return refused;
    if (!outcome.ok || actor.kind !== "person")
        throw new Error("unreachable: refusals were returned above");
    if (outcome.waived && body.data.waiver_reason === undefined) {
        return problemResponse(c, "invalid_request", "Invalid request", "a waiver needs a reason");
    }
    const tx = c.get("tx");
    try {
        // One current version: the release being replaced is retired first, in this transaction.
        const previous = await otherReleasedVersion(tx, row.task_id, row.id);
        if (previous !== null && !(await moveState(tx, previous, "released", "retired")))
            return raced(c);
        const released = await recordRelease(tx, {
            versionId: row.id,
            from: row.state,
            waived: outcome.waived,
            releasedBy: actor.userId,
            at: new Date(deps.clock.nowUnixMs()),
        });
        if (!released) return raced(c);
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === CHECK_VIOLATION || code === UNIQUE_VIOLATION) return raced(c);
        throw error;
    }
    await appendAudit(
        tx,
        versionAudit(actor.userId, row, "task_version.released", {
            waived: outcome.waived,
            ...(body.data.waiver_reason === undefined
                ? {}
                : { waiver_reason: body.data.waiver_reason }),
        }),
    );
    return respond(c, row.id);
}
