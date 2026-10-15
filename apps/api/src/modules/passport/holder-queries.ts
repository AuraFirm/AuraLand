import { CREDENTIAL_KINDS } from "@aura/contracts/credentials";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for a holder's own credentials and links, run as `aura_app`. The policies and functions of migration 0057 decide
// whose they are.

const credentialRow = z.object({
    id: z.string(),
    kind: z.enum(CREDENTIAL_KINDS),
    claim: z.object({ event_title: z.string() }),
    assurance_level: z.number().int(),
    issued_at: z.date(),
    expires_at: z.date().nullable(),
    revoked_at: z.date().nullable(),
    visibility: z.enum(["private", "link", "public"]),
});
const shareRow = z.object({
    id: z.string(),
    credential_id: z.string(),
    expires_at: z.date(),
    revoked_at: z.date().nullable(),
});
export type CredentialRowOut = z.infer<typeof credentialRow>;
export type ShareRowOut = z.infer<typeof shareRow>;

const LIST_MAX = 200;

export async function ownCredentials(tx: Transaction): Promise<CredentialRowOut[]> {
    const rows =
        await tx`select id, kind, claim, assurance_level, issued_at, expires_at, revoked_at, visibility
        from credentials where subject_user_id = app_user() order by issued_at desc, id desc limit ${LIST_MAX}`;
    return rows.map((row) => credentialRow.parse(row));
}

export async function ownShares(tx: Transaction): Promise<ShareRowOut[]> {
    const rows = await tx`select id, credential_id, expires_at, revoked_at from credential_shares
        where subject_user_id = app_user() order by id desc limit ${LIST_MAX * 5}`;
    return rows.map((row) => shareRow.parse(row));
}

export const setVisibility = (tx: Transaction, id: string, visibility: string) =>
    tx`select set_credential_visibility(${id}, ${visibility})`;

export async function createShare(
    tx: Transaction,
    input: { credential: string; tokenHash: Buffer; days: number; nowMs: number },
): Promise<{ id: string; expiresAt: Date }> {
    const [row] =
        await tx`select share_id, expires_at from create_credential_share(${input.credential},
        ${input.tokenHash}, ${input.days}, ${new Date(input.nowMs)})`;
    const parsed = z.object({ share_id: z.string(), expires_at: z.date() }).parse(row);
    return { id: parsed.share_id, expiresAt: parsed.expires_at };
}

export const revokeShare = (tx: Transaction, id: string, nowMs: number) =>
    tx`select revoke_credential_share(${id}, ${new Date(nowMs)})`;
