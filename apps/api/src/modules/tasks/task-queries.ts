import { TASK_PAGE_SIZE_MAX } from "@aura/contracts/limits";
import { taskKindSchema, taskVisibilitySchema } from "@aura/contracts/tasks";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for tasks, run as `aura_app` so row-level security decides which rows exist for the caller.
// A task and its released version are read together: the released version is the "current" one.

const taskRowSchema = z.object({
    id: z.string(),
    org_id: z.string(),
    slug: z.string(),
    kind: taskKindSchema,
    visibility: taskVisibilitySchema,
    title: z.string(),
    created_at: z.date(),
    updated_at: z.date(),
    released_version_id: z.string().nullable(),
    released_version_seq: z.number().int().nullable(),
});
export type TaskRow = z.infer<typeof taskRowSchema>;

export async function insertTask(
    tx: Transaction,
    input: {
        orgId: string;
        slug: string;
        title: string;
        kind: string;
        visibility: string;
        userId: string;
    },
): Promise<string> {
    const rows = await tx`
        insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${input.orgId}, ${input.slug}, ${input.kind}, ${input.visibility}, ${input.title}, ${input.userId})
        returning id`;
    return z.object({ id: z.string() }).parse(rows[0]).id;
}

export async function getTask(tx: Transaction, taskId: string): Promise<TaskRow | null> {
    const rows = await tx`
        select t.id, t.org_id, t.slug, t.kind, t.visibility, t.title, t.created_at, t.updated_at,
               v.id as released_version_id, v.seq as released_version_seq
        from tasks t
        left join task_versions v on v.task_id = t.id and v.state = 'released'
        where t.id = ${taskId}`;
    return rows[0] === undefined ? null : taskRowSchema.parse(rows[0]);
}

// Newest first by id (UUIDv7 sorts by creation time and is unique, so paging never skips or repeats).
// One extra row is read to know whether another page exists.
export async function listTasks(
    tx: Transaction,
    orgId: string,
    cursor: string | null,
    limit: number,
): Promise<{ rows: TaskRow[]; hasMore: boolean }> {
    const pageSize = Math.min(limit, TASK_PAGE_SIZE_MAX);
    const rows = await tx`
        select t.id, t.org_id, t.slug, t.kind, t.visibility, t.title, t.created_at, t.updated_at,
               v.id as released_version_id, v.seq as released_version_seq
        from tasks t
        left join task_versions v on v.task_id = t.id and v.state = 'released'
        where t.org_id = ${orgId} and (${cursor}::uuid is null or t.id < ${cursor}::uuid)
        order by t.id desc
        limit ${pageSize + 1}`;
    const parsed = rows.map((row) => taskRowSchema.parse(row));
    return { rows: parsed.slice(0, pageSize), hasMore: parsed.length > pageSize };
}

export async function updateTask(
    tx: Transaction,
    taskId: string,
    change: { title?: string | undefined; visibility?: string | undefined },
): Promise<boolean> {
    const rows = await tx`
        update tasks set title = coalesce(${change.title ?? null}, title),
                         visibility = coalesce(${change.visibility ?? null}, visibility)
        where id = ${taskId} returning id`;
    return rows.length === 1;
}
