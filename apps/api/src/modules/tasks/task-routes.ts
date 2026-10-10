import {
    taskCreateRequestSchema,
    taskListQuerySchema,
    taskSchema,
    tasksResponseSchema,
    taskUpdateRequestSchema,
} from "@aura/contracts/api/tasks";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import {
    CHECK_VIOLATION,
    postgresConstraint,
    postgresErrorCode,
    UNIQUE_VIOLATION,
} from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { RateLimitRule } from "../../platform/rate-limit.ts";
import {
    consumeRateLimit,
    type RateLimitDeps,
    refuseRateLimited,
} from "../../rate-limit-middleware.ts";
import { type Access, type Membership, taskAccess } from "./access.ts";
import { TASKS_CREATED_PER_USER_PER_DAY_MAX } from "./limits.ts";
import { getTask, insertTask, listTasks, type TaskRow, updateTask } from "./task-queries.ts";

export type TaskRouteDeps = Pick<RateLimitDeps, "sql" | "clock" | "key">;

const DAY_S = 24 * 60 * 60;
const CREATE_BY_USER: RateLimitRule = {
    name: "task-create:user",
    max: TASKS_CREATED_PER_USER_PER_DAY_MAX,
    windowS: DAY_S,
};

// Task routes. They run in the request transaction as `aura_app`, so PostgreSQL row-level security
// applies on top of the `authorize` checks here. Whoever is not allowed to know a task exists gets
// 404, never 403.
export function taskRoutes(deps: TaskRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/tasks", (c) => handleCreate(c, deps));
    routes.get("/tasks", handleList);
    routes.get("/tasks/:id", handleGet);
    routes.patch("/tasks/:id", handleUpdate);
    return routes;
}

interface Caller {
    readonly userId: string;
    readonly orgs: readonly Membership[];
}

function caller(c: Context<AppEnv>): Caller | null {
    const actor = c.get("actor");
    return actor.kind === "user" ? { userId: actor.userId, orgs: actor.orgs } : null;
}

const unauthenticated = (c: Context<AppEnv>) =>
    problemResponse(c, "unauthenticated", "Authentication required");
const invalid = (c: Context<AppEnv>) => problemResponse(c, "invalid_request", "Invalid request");
const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");

const readJson = (c: Context<AppEnv>): Promise<unknown> =>
    c.req.json().then(
        (body: unknown) => body,
        () => null,
    );

function refuse(c: Context<AppEnv>, decision: Access): Response | null {
    if (decision.allowed) return null;
    return decision.reason === "not_member"
        ? notFound(c)
        : problemResponse(c, "forbidden", "Forbidden");
}

export function taskBody(row: TaskRow) {
    return taskSchema.parse({
        id: encodeId("tsk", row.id),
        org_id: encodeId("org", row.org_id),
        slug: row.slug,
        kind: row.kind,
        visibility: row.visibility,
        title: row.title,
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
        released_version:
            row.released_version_id === null || row.released_version_seq === null
                ? null
                : { id: encodeId("tsv", row.released_version_id), seq: row.released_version_seq },
    });
}

function taskAudit(userId: string, orgId: string, action: string, taskId: string, detail = {}) {
    return {
        actorKind: "user",
        actorUserId: userId,
        orgId,
        action,
        target: encodeId("tsk", taskId),
        detail,
    } as const;
}

async function handleCreate(c: Context<AppEnv>, deps: TaskRouteDeps) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const body = taskCreateRequestSchema.safeParse(await readJson(c));
    if (!body.success) return invalid(c);
    const orgId = decodeId("org", body.data.org_id);
    const denied = refuse(c, taskAccess(who.orgs, orgId, "write"));
    if (denied !== null) return denied;
    const verdict = await consumeRateLimit(deps, CREATE_BY_USER, who.userId);
    if (!verdict.allowed) return refuseRateLimited(c, verdict);
    const tx = c.get("tx");
    let taskId: string;
    try {
        taskId = await insertTask(tx, {
            orgId,
            slug: body.data.slug,
            title: body.data.title,
            kind: body.data.kind,
            visibility: body.data.visibility,
            userId: who.userId,
        });
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === UNIQUE_VIOLATION)
            return problemResponse(c, "conflict", "That address is taken");
        if (code === CHECK_VIOLATION && postgresConstraint(error) === null) {
            return problemResponse(
                c,
                "conflict",
                "This organization has the maximum number of tasks",
            );
        }
        throw error;
    }
    const row = await getTask(tx, taskId);
    if (row === null) throw new Error("a new task is visible to its creator");
    await appendAudit(
        tx,
        taskAudit(who.userId, orgId, "task.created", taskId, { kind: row.kind, slug: row.slug }),
    );
    return c.json(taskBody(row), 201);
}

async function handleList(c: Context<AppEnv>) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const query = taskListQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalid(c);
    const orgId = decodeId("org", query.data.org_id);
    const denied = refuse(c, taskAccess(who.orgs, orgId, "read"));
    if (denied !== null) return denied;
    const cursor = query.data.cursor === undefined ? null : decodeId("tsk", query.data.cursor);
    const page = await listTasks(c.get("tx"), orgId, cursor, query.data.limit);
    const last = page.rows[page.rows.length - 1];
    return c.json(
        tasksResponseSchema.parse({
            items: page.rows.map(taskBody),
            next_cursor: page.hasMore && last !== undefined ? encodeId("tsk", last.id) : null,
        }),
    );
}

function taskIdParam(c: Context<AppEnv>): string | null {
    const parsed = idSchema("tsk").safeParse(c.req.param("id"));
    return parsed.success ? decodeId("tsk", parsed.data) : null;
}

async function handleGet(c: Context<AppEnv>) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const taskId = taskIdParam(c);
    if (taskId === null) return invalid(c);
    // Row-level security hides tasks the caller may not see: absent and forbidden look the same.
    const row = await getTask(c.get("tx"), taskId);
    return row === null ? notFound(c) : c.json(taskBody(row));
}

async function handleUpdate(c: Context<AppEnv>) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const taskId = taskIdParam(c);
    const body = taskUpdateRequestSchema.safeParse(await readJson(c));
    if (taskId === null || !body.success) return invalid(c);
    const tx = c.get("tx");
    const existing = await getTask(tx, taskId);
    if (existing === null) return notFound(c);
    const denied = refuse(c, taskAccess(who.orgs, existing.org_id, "write"));
    if (denied !== null) return denied;
    if (!(await updateTask(tx, taskId, body.data))) return notFound(c);
    await appendAudit(tx, taskAudit(who.userId, existing.org_id, "task.updated", taskId));
    const row = await getTask(tx, taskId);
    if (row === null) throw new Error("the task is visible to its writer");
    return c.json(taskBody(row));
}
