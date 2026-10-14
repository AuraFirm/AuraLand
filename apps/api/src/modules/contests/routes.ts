import {
    contestListQuerySchema,
    contestProblemAddRequestSchema,
    contestSchema,
    contestsResponseSchema,
    contestUpdateRequestSchema,
    registrationResponseSchema,
} from "@aura/contracts/api/contests";
import { contestCreateRequestSchema } from "@aura/contracts/contests";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { CONTEST_REGISTRATIONS_PER_MINUTE_PER_USER_MAX } from "@aura/contracts/limits";
import { appendAudit } from "@aura/db/audit";
import { CHECK_VIOLATION, postgresErrorCode, UNIQUE_VIOLATION } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { RateLimitRule } from "../../platform/rate-limit.ts";
import {
    consumeRateLimit,
    type RateLimitDeps,
    refuseRateLimited,
} from "../../rate-limit-middleware.ts";
import * as q from "./queries.ts";

export type ContestRouteDeps = Pick<RateLimitDeps, "sql" | "clock" | "key">;

const NO_DATA_FOUND = "P0002";
const INSUFFICIENT_PRIVILEGE = "42501";
const REGISTER_BY_USER: RateLimitRule = {
    name: "contest-register:user",
    max: CONTEST_REGISTRATIONS_PER_MINUTE_PER_USER_MAX,
    windowS: 60,
};

// Contests: who can find them, arrange them and register. What a person may see is decided by row-level
// security (a draft is the host staff's, a private contest its members', problems appear at the start);
// who may change a contest is decided by the database functions of migrations 0033 and 0034. These
// routes turn those answers into responses and keep the audit trail.
export function contestRoutes(deps: ContestRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/contests", handleList);
    routes.get("/contests/:id", handleGet);
    routes.post("/orgs/:id/contests", handleCreate);
    routes.patch("/contests/:id", handleUpdate);
    routes.post("/contests/:id/problems", handleAddProblem);
    routes.delete("/contests/:id/problems/:label", handleRemoveProblem);
    routes.post("/contests/:id/publish", (c) => handlePublish(c, deps));
    routes.post("/contests/:id/finalize", (c) => handleFinalize(c, deps));
    routes.post("/contests/:id/registrations", (c) => handleRegister(c, deps));
    return routes;
}

const invalid = (c: Context<AppEnv>) => problemResponse(c, "invalid_request", "Invalid request");
const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");
const readJson = (c: Context<AppEnv>): Promise<unknown> =>
    c.req.json().then(
        (body: unknown) => body,
        () => null,
    );

function person(c: Context<AppEnv>) {
    const actor = c.get("actor");
    return actor.kind === "user" ? actor : null;
}

const isManager = (c: Context<AppEnv>, orgId: string): boolean => {
    const actor = person(c);
    const role = actor?.orgs.find((membership) => membership.orgId === orgId)?.role;
    return role === "owner" || role === "admin";
};

// The contest as the caller may see it: problems only when the database shows them, "registered" only
// for a signed-in person, and whether they may arrange it.
async function body(c: Context<AppEnv>, row: q.ContestRow) {
    const tx = c.get("tx");
    const actor = person(c);
    return contestSchema.parse({
        id: encodeId("cst", row.id),
        org_id: encodeId("org", row.org_id),
        slug: row.slug,
        title: row.title,
        format: row.format,
        rules: row.rules,
        visibility: row.visibility,
        ai_policy: row.ai_policy,
        rated: row.rated,
        assurance_level: 0,
        state: row.state,
        starts_at: row.starts_at.toISOString(),
        ends_at: row.ends_at.toISOString(),
        freeze_at: row.freeze_at?.toISOString() ?? null,
        finalized_at: row.finalized_at?.toISOString() ?? null,
        problems: await q.problemsOf(tx, row.id),
        registered: actor === null ? null : await q.isRegistered(tx, row.id, actor.userId),
        can_manage: isManager(c, row.org_id),
    });
}

async function handleList(c: Context<AppEnv>) {
    const query = contestListQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalid(c);
    const page = await q.listContests(c.get("tx"), {
        orgId: query.data.org_id === undefined ? null : decodeId("org", query.data.org_id),
        cursor: query.data.cursor === undefined ? null : decodeId("cst", query.data.cursor),
        limit: query.data.limit,
    });
    const last = page.rows[page.rows.length - 1];
    return c.json(
        contestsResponseSchema.parse({
            contests: await Promise.all(page.rows.map((row) => body(c, row))),
            next_cursor: page.hasMore && last !== undefined ? encodeId("cst", last.id) : null,
        }),
    );
}

function contestIdParam(c: Context<AppEnv>): string | null {
    const parsed = idSchema("cst").safeParse(c.req.param("id"));
    return parsed.success ? decodeId("cst", parsed.data) : null;
}

async function handleGet(c: Context<AppEnv>) {
    const id = contestIdParam(c);
    if (id === null) return notFound(c);
    const row = await q.getContest(c.get("tx"), id);
    return row === null ? notFound(c) : c.json(await body(c, row));
}

async function handleCreate(c: Context<AppEnv>) {
    const actor = person(c);
    if (actor === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const org = idSchema("org").safeParse(c.req.param("id"));
    const request = contestCreateRequestSchema.safeParse(await readJson(c));
    if (!org.success || !request.success) return invalid(c);
    const orgId = decodeId("org", org.data);
    if (!actor.orgs.some((membership) => membership.orgId === orgId)) return notFound(c);
    if (!isManager(c, orgId)) return problemResponse(c, "forbidden", "Forbidden");
    const tx = c.get("tx");
    try {
        const row = await q.insertContest(tx, {
            orgId,
            userId: actor.userId,
            contest: request.data,
        });
        for (const problem of request.data.problems) {
            await q.addProblem(
                tx,
                row.id,
                problem.label,
                decodeId("tsv", problem.task_version_id),
                problem.points,
            );
        }
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: actor.userId,
            orgId,
            action: "contest.created",
            target: encodeId("cst", row.id),
            detail: { format: row.format, problems: request.data.problems.length },
        });
        return c.json(await body(c, row), 201);
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === UNIQUE_VIOLATION)
            return problemResponse(c, "conflict", "That address is taken");
        if (code === CHECK_VIOLATION) return invalid(c);
        if (code === NO_DATA_FOUND)
            return problemResponse(
                c,
                "invalid_request",
                "Invalid request",
                "a problem is not a released version you can use",
            );
        if (code === INSUFFICIENT_PRIVILEGE) return problemResponse(c, "forbidden", "Forbidden");
        throw error;
    }
}

async function handleUpdate(c: Context<AppEnv>) {
    const actor = person(c);
    if (actor === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const id = contestIdParam(c);
    const request = contestUpdateRequestSchema.safeParse(await readJson(c));
    if (id === null || !request.success) return invalid(c);
    const tx = c.get("tx");
    const current = await q.getContest(tx, id);
    if (current === null) return notFound(c);
    if (!isManager(c, current.org_id)) return problemResponse(c, "forbidden", "Forbidden");
    try {
        const patch = request.data;
        const row = await q.updateContest(tx, id, {
            ...(patch.title === undefined ? {} : { title: patch.title }),
            ...(patch.rules === undefined ? {} : { rules: patch.rules }),
            ...(patch.visibility === undefined ? {} : { visibility: patch.visibility }),
            ...(patch.ai_policy === undefined ? {} : { ai_policy: patch.ai_policy }),
            ...(patch.rated === undefined ? {} : { rated: patch.rated }),
            ...(patch.starts_at === undefined ? {} : { starts_at: new Date(patch.starts_at) }),
            ...(patch.ends_at === undefined ? {} : { ends_at: new Date(patch.ends_at) }),
            ...(patch.freeze_at === undefined
                ? {}
                : { freeze_at: patch.freeze_at === null ? null : new Date(patch.freeze_at) }),
        });
        // A published contest is not updatable: the row is simply not touched.
        if (row === null)
            return problemResponse(c, "conflict", "Only a draft contest can be changed");
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: actor.userId,
            orgId: row.org_id,
            action: "contest.updated",
            target: encodeId("cst", id),
            detail: { fields: Object.keys(request.data) },
        });
        return c.json(await body(c, row));
    } catch (error) {
        if (postgresErrorCode(error) === CHECK_VIOLATION) return invalid(c);
        throw error;
    }
}

async function handleAddProblem(c: Context<AppEnv>) {
    const actor = person(c);
    if (actor === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const id = contestIdParam(c);
    const request = contestProblemAddRequestSchema.safeParse(await readJson(c));
    if (id === null || !request.success) return invalid(c);
    const tx = c.get("tx");
    try {
        await q.addProblem(
            tx,
            id,
            request.data.label,
            decodeId("tsv", request.data.task_version_id),
            request.data.points,
        );
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND) return notFound(c);
        if (code === UNIQUE_VIOLATION || code === CHECK_VIOLATION)
            return problemResponse(c, "conflict", "That problem cannot be added");
        if (code === INSUFFICIENT_PRIVILEGE)
            return problemResponse(c, "conflict", "Only a draft contest can be changed");
        throw error;
    }
    const row = await q.getContest(tx, id);
    if (row === null) return notFound(c);
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: row.org_id,
        action: "contest.problem_added",
        target: encodeId("cst", id),
        detail: { label: request.data.label },
    });
    return c.json(await body(c, row), 201);
}

async function handleRemoveProblem(c: Context<AppEnv>) {
    const actor = person(c);
    if (actor === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const id = contestIdParam(c);
    const label = c.req.param("label") ?? "";
    if (id === null || !/^[A-Z][A-Z0-9]{0,2}$/.test(label)) return invalid(c);
    const tx = c.get("tx");
    const before = await q.getContest(tx, id);
    try {
        await q.removeProblem(tx, id, label);
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND) return notFound(c);
        if (code === INSUFFICIENT_PRIVILEGE)
            return problemResponse(c, "conflict", "Only a draft contest can be changed");
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: before?.org_id ?? null,
        action: "contest.problem_removed",
        target: encodeId("cst", id),
        detail: { label },
    });
    return c.body(null, 204);
}

async function transition(
    c: Context<AppEnv>,
    deps: ContestRouteDeps,
    kind: "publish" | "finalize",
) {
    const actor = person(c);
    if (actor === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const id = contestIdParam(c);
    if (id === null) return notFound(c);
    const tx = c.get("tx");
    const before = await q.getContest(tx, id);
    if (before === null) return notFound(c);
    if (!isManager(c, before.org_id)) return problemResponse(c, "forbidden", "Forbidden");
    try {
        if (kind === "publish") await q.publish(tx, id, deps.clock.nowUnixMs());
        else await q.finalize(tx, id, deps.clock.nowUnixMs());
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND)
            return problemResponse(c, "conflict", "This contest is not in the right state");
        if (code === CHECK_VIOLATION)
            return problemResponse(
                c,
                "conflict",
                "A contest is published before it starts, with at least one problem",
            );
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: before.org_id,
        action: kind === "publish" ? "contest.published" : "contest.finalized",
        target: encodeId("cst", id),
    });
    const row = await q.getContest(tx, id);
    return row === null ? notFound(c) : c.json(await body(c, row));
}
const handlePublish = (c: Context<AppEnv>, deps: ContestRouteDeps) =>
    transition(c, deps, "publish");
const handleFinalize = (c: Context<AppEnv>, deps: ContestRouteDeps) =>
    transition(c, deps, "finalize");

async function handleRegister(c: Context<AppEnv>, deps: ContestRouteDeps) {
    const actor = person(c);
    if (actor === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const id = contestIdParam(c);
    if (id === null) return notFound(c);
    const verdict = await consumeRateLimit(deps, REGISTER_BY_USER, actor.userId);
    if (!verdict.allowed) return refuseRateLimited(c, verdict);
    const tx = c.get("tx");
    let status: "registered" | "already";
    try {
        status = await q.register(tx, id, deps.clock.nowUnixMs());
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND) return notFound(c);
        if (code === CHECK_VIOLATION)
            return problemResponse(
                c,
                "forbidden",
                "Forbidden",
                "organizers and problem authors do not compete",
            );
        throw error;
    }
    if (status === "registered") {
        const row = await q.getContest(tx, id);
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: actor.userId,
            orgId: row?.org_id ?? null,
            action: "contest.registered",
            target: encodeId("cst", id),
        });
    }
    return c.json(
        registrationResponseSchema.parse({ status }),
        status === "registered" ? 201 : 200,
    );
}
