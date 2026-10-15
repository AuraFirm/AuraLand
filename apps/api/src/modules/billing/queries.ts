import { type Entitlements, entitlementsSchema } from "@aura/contracts/api/billing";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for plans and customers. The database function decides who may ask and who may change a plan.

// Null when the caller is not a member of the organization (or it does not exist): the same answer for both.
export async function entitlementsOf(tx: Transaction, org: string): Promise<Entitlements | null> {
    const [row] = await tx`select * from org_entitlements(${org})`;
    return row === undefined ? null : entitlementsSchema.parse(row);
}

export async function setPlan(
    tx: Transaction,
    input: {
        org: string;
        plan: string;
        billingRef: string | null;
        contractRef: string | null;
        nowMs: number;
    },
): Promise<void> {
    await tx`select set_org_plan(${input.org}, ${input.plan}, ${input.billingRef}, ${input.contractRef}, ${new Date(input.nowMs)})`;
}

const usageRow = z.object({
    kind: z.enum(["env_run", "employer_report"]),
    used: z.coerce.number().int(),
});

// Counts per kind for [fromMs, toMs); empty (not zeros) when the caller is not a member, so callers must treat that as "no such
// organization" and not as "no usage".
export async function usageOf(
    tx: Transaction,
    org: string,
    fromMs: number,
    toMs: number,
): Promise<Record<"env_run" | "employer_report", number> | null> {
    const rows = (
        await tx`select * from org_usage(${org}, ${new Date(fromMs)}, ${new Date(toMs)})`
    ).map((row) => usageRow.parse(row));
    if (rows.length === 0) return null;
    const counts = { env_run: 0, employer_report: 0 };
    for (const row of rows) counts[row.kind] = row.used;
    return counts;
}
