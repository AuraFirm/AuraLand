import { batchSchema } from "@aura/contracts/api/revenue";
import { encodeId } from "@aura/contracts/ids";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for setter revenue share. Every write is a database function that checks the platform administrator role itself.

export async function setTerms(
    tx: Transaction,
    input: { task: string; user: string; bps: number; nowMs: number },
): Promise<void> {
    await tx`select set_setter_terms(${input.task}, ${input.user}, ${input.bps}, ${new Date(input.nowMs)})`;
}

export async function bookRevenue(
    tx: Transaction,
    input: { order: string; version: string; amount: number; currency: string; nowMs: number },
): Promise<void> {
    await tx`select book_order_revenue(${input.order}, ${input.version}, ${input.amount}, ${input.currency}, ${new Date(input.nowMs)})`;
}

export async function createBatch(
    tx: Transaction,
    input: { currency: string; minimum: number; nowMs: number },
): Promise<string> {
    const [row] =
        await tx`select create_payout_batch(${input.currency}, ${input.minimum}, ${new Date(input.nowMs)}) as id`;
    return z.object({ id: z.string() }).parse(row).id;
}

export async function markPaid(
    tx: Transaction,
    batch: string,
    reference: string,
    nowMs: number,
): Promise<void> {
    await tx`select mark_payout_batch_paid(${batch}, ${reference}, ${new Date(nowMs)})`;
}

export async function cancelBatch(tx: Transaction, batch: string): Promise<void> {
    await tx`select cancel_payout_batch(${batch})`;
}

const batchRow = z.object({
    id: z.string(),
    currency: z.string(),
    state: z.string(),
    total: z.coerce.number(),
    lines: z.coerce.number(),
    created_at: z.date(),
    paid_at: z.date().nullable(),
});

const toBatch = (raw: unknown) => {
    const row = batchRow.parse(raw);
    return batchSchema.parse({
        id: encodeId("pbt", row.id),
        currency: row.currency,
        state: row.state,
        total_minor: row.total,
        lines: row.lines,
        created_at: row.created_at.toISOString(),
        paid_at: row.paid_at?.toISOString() ?? null,
    });
};

export async function listBatches(tx: Transaction) {
    const rows = await tx`select b.id, b.currency, b.state, b.created_at, b.paid_at,
            coalesce(sum(l.amount_minor), 0) as total, count(l.user_id) as lines
        from payout_batches b left join payout_batch_lines l on l.batch_id = b.id
        group by b.id order by b.id desc limit 50`;
    return rows.map(toBatch);
}

export async function getBatch(tx: Transaction, id: string) {
    const [row] = await tx`select b.id, b.currency, b.state, b.created_at, b.paid_at,
            coalesce(sum(l.amount_minor), 0) as total, count(l.user_id) as lines
        from payout_batches b left join payout_batch_lines l on l.batch_id = b.id where b.id = ${id} group by b.id`;
    return row === undefined ? null : toBatch(row);
}

export async function myEarnings(tx: Transaction) {
    const rows = await tx`select * from my_earnings() order by currency`;
    return rows.map((raw) => {
        const row = z
            .object({
                currency: z.string(),
                owed_minor: z.coerce.number(),
                available_minor: z.coerce.number(),
            })
            .parse(raw);
        return {
            currency: row.currency,
            owed_minor: row.owed_minor,
            available_minor: row.available_minor,
        };
    });
}
