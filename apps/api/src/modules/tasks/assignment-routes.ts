import {
    assignmentCreateRequestSchema,
    assignmentSchema,
    assignmentsResponseSchema,
} from "@aura/contracts/api/assignments";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { CHECK_VIOLATION, postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { caller, invalid, notFound, readJson, unauthenticated } from "./route-support.ts";
import { assignStaff, listAssignments, taskOrgOf, unassignStaff } from "./task-queries.ts";

export interface AssignmentRouteDeps {
    readonly clock: Clock;
}

const NO_DATA_FOUND = "P0002";

// Owners and admins say who works on a task. The database functions check the role again, so a
// person who is not an owner or admin of the task's organization gets the same 404 as for a task
// that does not exist.
export function assignmentRoutes(deps: AssignmentRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/tasks/:id/assignments", handleList);
    routes.post("/tasks/:id/assignments", (c) => handleAssign(c, deps));
    routes.delete("/tasks/:id/assignments/:userId", handleUnassign);
    return routes;
}

async function handleList(c: Context<AppEnv>) {
    if (caller(c) === null) return unauthenticated(c);
    const task = idSchema("tsk").safeParse(c.req.param("id"));
    if (!task.success) return notFound(c);
    const tx = c.get("tx");
    const taskId = decodeId("tsk", task.data);
    // A task the caller cannot see does not exist for them, so the list is a 404, not an empty list.
    if ((await taskOrgOf(tx, taskId)) === null) return notFound(c);
    const rows = await listAssignments(tx, taskId);
    return c.json(assignmentsResponseSchema.parse({ assignments: rows.map(body) }));
}

const body = (row: { user_id: string; created_at: Date }) =>
    assignmentSchema.parse({
        user_id: encodeId("usr", row.user_id),
        created_at: row.created_at.toISOString(),
    });

async function handleAssign(c: Context<AppEnv>, deps: AssignmentRouteDeps) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const task = idSchema("tsk").safeParse(c.req.param("id"));
    const request = assignmentCreateRequestSchema.safeParse(await readJson(c));
    if (!task.success || !request.success) return invalid(c);
    const tx = c.get("tx");
    const taskId = decodeId("tsk", task.data);
    const userId = decodeId("usr", request.data.user_id);
    try {
        await assignStaff(tx, taskId, userId, deps.clock.nowUnixMs());
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND) return notFound(c);
        if (code === CHECK_VIOLATION) {
            return problemResponse(c, "conflict", "Only a setter or reviewer can be assigned");
        }
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: who.userId,
        orgId: await taskOrgOf(tx, taskId),
        action: "task.staff_assigned",
        target: encodeId("tsk", taskId),
        detail: { user_id: request.data.user_id },
    });
    const rows = await listAssignments(tx, taskId);
    return c.json(assignmentsResponseSchema.parse({ assignments: rows.map(body) }), 201);
}

async function handleUnassign(c: Context<AppEnv>) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const task = idSchema("tsk").safeParse(c.req.param("id"));
    const user = idSchema("usr").safeParse(c.req.param("userId"));
    if (!task.success || !user.success) return invalid(c);
    const tx = c.get("tx");
    const taskId = decodeId("tsk", task.data);
    const orgId = await taskOrgOf(tx, taskId);
    try {
        await unassignStaff(tx, taskId, decodeId("usr", user.data));
    } catch (error) {
        if (postgresErrorCode(error) === NO_DATA_FOUND) return notFound(c);
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: who.userId,
        orgId,
        action: "task.staff_unassigned",
        target: encodeId("tsk", taskId),
        detail: { user_id: user.data },
    });
    return c.body(null, 204);
}
