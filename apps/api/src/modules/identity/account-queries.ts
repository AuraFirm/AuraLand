import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for account-level actions, run as `aura_app` for the signed-in person.

// A person may mark their own account for deletion, or take the mark back. The purge itself needs the
// worker role (Stage 3).
export async function setDeletionRequested(
    tx: Transaction,
    userId: string,
    atMs: number | null,
): Promise<void> {
    await tx`
        update users set deletion_requested_at = ${atMs === null ? null : new Date(atMs)}
        where id = ${userId}
    `;
}

const auditSchema = z.object({
    at: z.date(),
    action: z.string(),
    target: z.string().nullable(),
});
export type AuditRow = z.infer<typeof auditSchema>;

// The most recent entries in which this person was the actor. Bounded on purpose: the export is a
// summary, and the full trail is for investigators.
export const EXPORT_AUDIT_ENTRIES_MAX = 200;

export async function listOwnAuditEntries(tx: Transaction, userId: string): Promise<AuditRow[]> {
    const rows = await tx`
        select at, action, target from audit_log
        where actor_user_id = ${userId} order by seq desc limit ${EXPORT_AUDIT_ENTRIES_MAX}
    `;
    return rows.map((row) => auditSchema.parse(row));
}
