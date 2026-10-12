import { COMMENTS_PAGE_SIZE_MAX } from "@aura/contracts/limits";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for version comments, run as `aura_app`: row-level security decides who may read or write.

const commentRowSchema = z.object({
    id: z.string(),
    org_id: z.string(),
    author_id: z.string(),
    parent_id: z.string().nullable(),
    body: z.string(),
    created_at: z.date(),
});
export type CommentRow = z.infer<typeof commentRowSchema>;

// Oldest first, so a thread reads top to bottom; the id breaks ties; bounded by the page size.
export async function listComments(tx: Transaction, versionId: string): Promise<CommentRow[]> {
    const rows = await tx`select id, org_id, author_id, parent_id, body, created_at
        from version_comments where task_version_id = ${versionId}
        order by created_at, id limit ${COMMENTS_PAGE_SIZE_MAX}`;
    return rows.map((row) => commentRowSchema.parse(row));
}

export async function insertComment(
    tx: Transaction,
    input: {
        orgId: string;
        versionId: string;
        authorId: string;
        parentId: string | null;
        body: string;
        nowMs: number;
    },
): Promise<CommentRow> {
    const rows =
        await tx`insert into version_comments (org_id, task_version_id, author_id, parent_id, body, created_at)
        values (${input.orgId}, ${input.versionId}, ${input.authorId}, ${input.parentId}, ${input.body}, ${new Date(input.nowMs)})
        returning id, org_id, author_id, parent_id, body, created_at`;
    return commentRowSchema.parse(rows[0]);
}
