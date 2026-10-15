import { type Entitlements, entitlementsSchema } from "@aura/contracts/api/billing";
import type { Transaction } from "@aura/db/context";

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
