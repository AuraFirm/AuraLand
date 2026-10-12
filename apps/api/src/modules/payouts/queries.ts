import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for contractor payouts, run as `aura_app`. Reads go through row-level security (a contractor
// sees their own, a platform administrator all); writes are database functions that check the role.

const payoutRowSchema = z.object({
    id: z.string(),
    contractor_id: z.string(),
    task_version_id: z.string(),
    amount_minor: z.coerce.number(),
    currency: z.string(),
    paid_at: z.date().nullable(),
    paid_reference: z.string().nullable(),
    created_at: z.date(),
});
export type PayoutRow = z.infer<typeof payoutRowSchema>;

// Newest first with the id as a tiebreaker. The caller's limit bounds the list.
export async function listPayouts(
    tx: Transaction,
    scope: { contractorId: string | null },
    limit: number,
): Promise<PayoutRow[]> {
    const rows =
        await tx`select id, contractor_id, task_version_id, amount_minor, currency, paid_at,
        paid_reference, created_at from contractor_payouts
        where ${scope.contractorId === null ? tx`true` : tx`contractor_id = ${scope.contractorId}`}
        order by created_at desc, id desc limit ${limit}`;
    return rows.map((row) => payoutRowSchema.parse(row));
}

export async function getPayout(tx: Transaction, payoutId: string): Promise<PayoutRow | null> {
    const rows =
        await tx`select id, contractor_id, task_version_id, amount_minor, currency, paid_at,
        paid_reference, created_at from contractor_payouts where id = ${payoutId}`;
    return rows[0] === undefined ? null : payoutRowSchema.parse(rows[0]);
}

export async function recordPayout(
    tx: Transaction,
    input: {
        contractorId: string;
        versionId: string;
        amountMinor: number;
        currency: string;
        nowMs: number;
    },
): Promise<string> {
    const rows = await tx`select record_payout(${input.contractorId}, ${input.versionId},
        ${input.amountMinor}, ${input.currency}, ${new Date(input.nowMs)}) as id`;
    return z.object({ id: z.string() }).parse(rows[0]).id;
}

export async function markPayoutPaid(
    tx: Transaction,
    payoutId: string,
    reference: string,
    nowMs: number,
) {
    await tx`select mark_payout_paid(${payoutId}, ${reference}, ${new Date(nowMs)})`;
}
