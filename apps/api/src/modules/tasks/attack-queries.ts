import { ATTACKS_PAGE_SIZE_MAX } from "@aura/contracts/limits";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for human attack findings, run as `aura_app`: row-level security decides who may read or write,
// and a trigger (migration 0030) refuses an author attacking their own version or a version that is
// not in a state worth attacking.

const attackRowSchema = z.object({
    id: z.string(),
    author_id: z.string(),
    outcome: z.enum(["held", "gamed"]),
    method: z.string(),
    created_at: z.date(),
});
export type AttackRow = z.infer<typeof attackRowSchema>;

// Oldest first; the id breaks ties; bounded by the page size.
export async function listAttacks(tx: Transaction, versionId: string): Promise<AttackRow[]> {
    const rows = await tx`select id, author_id, outcome, method, created_at
        from attack_findings where task_version_id = ${versionId}
        order by created_at, id limit ${ATTACKS_PAGE_SIZE_MAX}`;
    return rows.map((row) => attackRowSchema.parse(row));
}

export async function insertAttack(
    tx: Transaction,
    input: {
        orgId: string;
        versionId: string;
        authorId: string;
        outcome: "held" | "gamed";
        method: string;
        nowMs: number;
    },
): Promise<AttackRow> {
    const rows =
        await tx`insert into attack_findings (org_id, task_version_id, author_id, outcome, method, created_at)
        values (${input.orgId}, ${input.versionId}, ${input.authorId}, ${input.outcome}, ${input.method}, ${new Date(input.nowMs)})
        returning id, author_id, outcome, method, created_at`;
    return attackRowSchema.parse(rows[0]);
}
