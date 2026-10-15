import { encodeId } from "@aura/contracts/ids";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { Clock } from "../../platform/clock.ts";
import type { PaymentProvider } from "./provider.ts";
import { reconcile, type UsageKind, type UsageLine } from "./reconcile.ts";
import { previousMonthUtc } from "./rules.ts";

export interface BillingTickContext {
    readonly clock: Clock;
    readonly provider: PaymentProvider;
    readonly inTransaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
}

// How often the worker looks at billing. The previous month is reconciled once; looking again costs one indexed read.
export const BILLING_TICK_MS = 60_000;

const totalRow = z.object({
    org_id: z.string(),
    kind: z.enum(["env_run", "employer_report"]),
    used: z.coerce.number().int(),
});

// Close the previous calendar month: report our counts to the provider, read back what it holds, compare, and keep the result.
// A month is recorded once; the result is the list of differences (empty when clean) or null when it was already done.
export async function reconcilePreviousMonth(
    context: BillingTickContext,
): Promise<{ period: string; differences: number } | null> {
    const { startMs, endMs, period } = previousMonthUtc(context.clock.nowUnixMs());
    const done = await context.inTransaction(async (tx) => {
        const [row] = await tx`select 1 as one from reconciliations where period = ${period}`;
        return row !== undefined;
    });
    if (done) return null;
    const ours = await context.inTransaction(async (tx) =>
        (await tx`select * from usage_totals(${new Date(startMs)}, ${new Date(endMs)})`)
            .map((row) => totalRow.parse(row))
            .map(
                (row): UsageLine => ({
                    org: encodeId("org", row.org_id),
                    kind: row.kind,
                    count: row.used,
                }),
            ),
    );
    await context.provider.reportUsage(period, ours);
    const theirs = await context.provider.listUsageLines(period);
    const differences = reconcile(ours, theirs);
    const recorded = await context.inTransaction(async (tx) => {
        const [row] =
            await tx`select record_reconciliation(${period}, ${tx.json(JSON.parse(JSON.stringify(ours)))},
            ${tx.json(JSON.parse(JSON.stringify(theirs)))}, ${tx.json(JSON.parse(JSON.stringify(differences)))},
            ${new Date(context.clock.nowUnixMs())}) as recorded`;
        return z.object({ recorded: z.boolean() }).parse(row).recorded;
    });
    return recorded ? { period, differences: differences.length } : null;
}
