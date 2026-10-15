import { CREDENTIAL_KINDS, credentialClaimSchema } from "@aura/contracts/credentials";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for the employer side, run as `aura_app`. The functions of migration 0059 decide who may.

const searchRow = z.object({
    id: z.string(),
    kind: z.enum(CREDENTIAL_KINDS),
    claim: credentialClaimSchema,
    assurance_level: z.number().int(),
    issued_at: z.date(),
    expires_at: z.date().nullable(),
});
export type SearchRow = z.infer<typeof searchRow>;

export async function search(
    tx: Transaction,
    input: { org: string; kind: string | null; after: string | null; limit: number },
) {
    const rows =
        await tx`select * from employer_search(${input.org}, ${input.kind}, ${input.after}, ${input.limit})`;
    return rows.map((row) => searchRow.parse(row));
}

const reportRow = z.object({
    id: z.string(),
    kind: z.enum(CREDENTIAL_KINDS),
    claim: credentialClaimSchema,
    assurance_level: z.number().int(),
    vc_jwt: z.string(),
    issued_at: z.date(),
    expires_at: z.date().nullable(),
    revoked_at: z.date().nullable(),
});
export type ReportRow = z.infer<typeof reportRow>;

export async function report(
    tx: Transaction,
    input: { org: string; credential: string; purpose: string; nowMs: number },
) {
    const [row] =
        await tx`select * from employer_report(${input.org}, ${input.credential}, ${input.purpose}, ${new Date(input.nowMs)})`;
    return reportRow.parse(row);
}

export const approve = (tx: Transaction, org: string, nowMs: number) =>
    tx`select approve_employer_org(${org}, ${new Date(nowMs)})`;
export const revoke = (tx: Transaction, org: string, nowMs: number) =>
    tx`select revoke_employer_org(${org}, ${new Date(nowMs)})`;

const viewRow = z.object({
    org_name: z.string(),
    purpose: z.enum(["hiring_screening", "verification"]),
    viewed_at: z.date(),
});
export async function ownViews(tx: Transaction, credential: string) {
    const rows = await tx`select * from my_credential_views(${credential})`;
    return rows.map((row) => viewRow.parse(row));
}
