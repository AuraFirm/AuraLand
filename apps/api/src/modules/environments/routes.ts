import {
    createEnvironmentRequestSchema,
    environmentSchema,
    environmentsResponseSchema,
    envRunSchema,
    envRunsResponseSchema,
    leaderboardResponseSchema,
    requestRunSchema,
} from "@aura/contracts/api/environments";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { CHECK_VIOLATION, postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import * as q from "./queries.ts";

export interface EnvironmentRouteDeps {
    readonly clock: Clock;
}

const NO_DATA_FOUND = "P0002";
const OBJECT_NOT_IN_STATE = "55000";
const PROGRAM_LIMIT_EXCEEDED = "54000";

// Environments (Stage 8, slice 8): an organization's Tier-2 recipes and the runs of agents in them. The database decides who
// may author and ask (owner, admin, setter of the organization); a stranger gets the same 404 as for a missing object.
export function environmentRoutes(deps: EnvironmentRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/orgs/:id/environments", (c) => handleCreate(c, deps));
    routes.get("/environments", handleList);
    routes.post("/environments/:id/runs", (c) => handleRequest(c, deps));
    routes.get("/environments/:id/runs", handleRuns);
    routes.get("/environments/:id/leaderboard", handleLeaderboard);
    routes.get("/env-runs/:id", handleRun);
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");
const invalid = (c: Context<AppEnv>, detail?: string) =>
    problemResponse(c, "invalid_request", "Invalid request", detail);

function user(c: Context<AppEnv>) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return { problem: problemResponse(c, "unauthenticated", "Authentication required") };
    return { actor };
}

function translated(c: Context<AppEnv>, error: unknown) {
    const code = postgresErrorCode(error);
    if (code === NO_DATA_FOUND) return notFound(c);
    if (code === CHECK_VIOLATION) return invalid(c);
    if (code === OBJECT_NOT_IN_STATE)
        return problemResponse(
            c,
            "conflict",
            "Conflict",
            "a run for this agent is already waiting",
        );
    if (code === PROGRAM_LIMIT_EXCEEDED)
        return problemResponse(c, "unavailable", "Busy", "the run queue is full");
    if (code === "23505")
        return problemResponse(c, "conflict", "Conflict", "that address is taken");
    throw error;
}

const toEnvironment = (row: q.EnvironmentRow) =>
    environmentSchema.parse({
        id: encodeId("env", row.id),
        org_id: encodeId("org", row.org_id),
        slug: row.slug,
        title: row.title,
        image_digest: row.spec.image.digest,
        network: row.spec.network.mode,
        created_at: row.created_at.toISOString(),
    });

async function handleCreate(c: Context<AppEnv>, deps: EnvironmentRouteDeps) {
    const who = user(c);
    if ("problem" in who) return who.problem;
    const org = idSchema("org").safeParse(c.req.param("id"));
    const body = createEnvironmentRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!org.success || !body.success) return invalid(c);
    // No node can contain a network allowlist yet (ADR 0034, slice 6): refuse it here rather than queue runs nobody can start.
    if (body.data.spec.network.mode !== "none") {
        return invalid(c, "network allowlists are not supported yet: set the network mode to none");
    }
    const tx = c.get("tx");
    try {
        const id = await q.createEnvironment(tx, {
            org: decodeId("org", org.data),
            slug: body.data.slug,
            title: body.data.title,
            spec: body.data.spec,
            imageKey: body.data.image_key,
            hiddenKey: body.data.hidden_key,
            hiddenSha256: body.data.hidden_sha256,
            nowMs: deps.clock.nowUnixMs(),
        });
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: who.actor.userId,
            orgId: null,
            action: "environment.created",
            target: encodeId("env", id),
            detail: { slug: body.data.slug },
        });
        const [row] = (await q.listEnvironments(tx, decodeId("org", org.data))).filter(
            (e) => e.id === id,
        );
        return c.json(toEnvironment(row as q.EnvironmentRow), 201); // tigerlint-allow: no-as-cast -- the row was just inserted and is visible to its creator
    } catch (error) {
        return translated(c, error);
    }
}

async function handleList(c: Context<AppEnv>) {
    const who = user(c);
    if ("problem" in who) return who.problem;
    const org = idSchema("org").safeParse(c.req.query("org_id"));
    if (!org.success) return invalid(c);
    const rows = await q.listEnvironments(c.get("tx"), decodeId("org", org.data));
    return c.json(environmentsResponseSchema.parse({ environments: rows.map(toEnvironment) }));
}

async function handleRequest(c: Context<AppEnv>, deps: EnvironmentRouteDeps) {
    const who = user(c);
    if ("problem" in who) return who.problem;
    const env = idSchema("env").safeParse(c.req.param("id"));
    const body = requestRunSchema.safeParse(await c.req.json().catch(() => null));
    if (!env.success || !body.success) return invalid(c);
    const tx = c.get("tx");
    try {
        const id = await q.requestRun(tx, {
            env: decodeId("env", env.data),
            label: body.data.agent_label,
            delivery: body.data.customer_delivery,
            optedIn: body.data.customer_opted_in,
            level: body.data.assurance_level,
            nowMs: deps.clock.nowUnixMs(),
        });
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: who.actor.userId,
            orgId: null,
            action: "environment.run_requested",
            target: encodeId("evr", id),
            detail: { assurance_level: body.data.assurance_level },
        });
        return c.json(
            z.object({ run_id: idSchema("evr") }).parse({ run_id: encodeId("evr", id) }),
            202,
        );
    } catch (error) {
        return translated(c, error);
    }
}

const toRun = (row: q.RunRow) =>
    envRunSchema.parse({
        id: encodeId("evr", row.id),
        environment_id: encodeId("env", row.environment_id),
        agent_label: row.agent_label,
        state: row.state,
        isolation: row.isolation,
        outcome: row.outcome,
        score: row.score,
        eligible: row.eligible,
        flags: row.flags,
        created_at: row.created_at.toISOString(),
        finished_at: row.finished_at?.toISOString() ?? null,
    });

async function handleRuns(c: Context<AppEnv>) {
    const who = user(c);
    if ("problem" in who) return who.problem;
    const env = idSchema("env").safeParse(c.req.param("id"));
    if (!env.success) return invalid(c);
    const tx = c.get("tx");
    const visible =
        await tx`select 1 as one from environments where id = ${decodeId("env", env.data)}`;
    if (visible.length === 0) return notFound(c);
    const rows = await q.listRuns(tx, decodeId("env", env.data));
    return c.json(envRunsResponseSchema.parse({ runs: rows.map(toRun) }));
}

async function handleRun(c: Context<AppEnv>) {
    const who = user(c);
    if ("problem" in who) return who.problem;
    const run = idSchema("evr").safeParse(c.req.param("id"));
    if (!run.success) return invalid(c);
    const row = await q.getRun(c.get("tx"), decodeId("evr", run.data));
    return row === null ? notFound(c) : c.json(toRun(row));
}

async function handleLeaderboard(c: Context<AppEnv>) {
    const who = user(c);
    if ("problem" in who) return who.problem;
    const env = idSchema("env").safeParse(c.req.param("id"));
    if (!env.success) return invalid(c);
    const tx = c.get("tx");
    const id = decodeId("env", env.data);
    const visible = await tx`select 1 as one from environments where id = ${id}`;
    if (visible.length === 0) return notFound(c);
    const rows = await q.leaderboard(tx, id);
    return c.json(
        leaderboardResponseSchema.parse({
            rows: rows.map((row, index) => ({
                rank: index + 1,
                agent_label: row.agent_label,
                best_score: row.best_score,
                runs: row.runs,
                flagged_runs: row.flagged_runs,
                isolation: row.isolation,
                achieved_at: row.achieved_at.toISOString(),
            })),
        }),
    );
}
