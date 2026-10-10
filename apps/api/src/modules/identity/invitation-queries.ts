import type { InvitableRole } from "@aura/contracts/api/invitations";
import { orgRoleSchema } from "@aura/contracts/identity";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for invitations. The first group runs as `aura_app` for an owner or admin; the last group runs
// as `aura_auth` when someone accepts, and is the only code that reads the link's hash.

export async function supersedeInvitations(
    tx: Transaction,
    orgId: string,
    email: string,
    nowMs: number,
): Promise<void> {
    await tx`
        update org_invitations set revoked_at = ${new Date(nowMs)}
        where org_id = ${orgId} and email = ${email} and accepted_at is null and revoked_at is null
    `;
}

export async function insertInvitation(
    tx: Transaction,
    input: {
        readonly orgId: string;
        readonly email: string;
        readonly role: InvitableRole;
        readonly tokenHash: string;
        readonly invitedBy: string;
        readonly nowMs: number;
        readonly ttlS: number;
    },
): Promise<string> {
    const rows = await tx`
        insert into org_invitations (org_id, email, role, token_hash, invited_by, created_at, expires_at)
        values (${input.orgId}, ${input.email}, ${input.role}, ${Buffer.from(input.tokenHash, "hex")},
                ${input.invitedBy}, ${new Date(input.nowMs)},
                ${new Date(input.nowMs + input.ttlS * 1000)})
        returning id
    `;
    return z.object({ id: z.string() }).parse(rows[0]).id;
}

const itemSchema = z.object({
    id: z.string(),
    email: z.string(),
    role: z.enum(["admin", "member"]),
    created_at: z.date(),
    expires_at: z.date(),
});
export type InvitationRow = z.infer<typeof itemSchema>;

export async function listPendingInvitations(
    tx: Transaction,
    orgId: string,
    nowMs: number,
): Promise<InvitationRow[]> {
    const rows = await tx`
        select id, email::text as email, role, created_at, expires_at
        from org_invitations
        where org_id = ${orgId} and accepted_at is null and revoked_at is null
          and expires_at > ${new Date(nowMs)}
        order by created_at, id limit 100
    `;
    return rows.map((row) => itemSchema.parse(row));
}

export async function getInvitation(
    tx: Transaction,
    orgId: string,
    id: string,
): Promise<InvitationRow | null> {
    const rows = await tx`
        select id, email::text as email, role, created_at, expires_at
        from org_invitations where org_id = ${orgId} and id = ${id}
    `;
    const row = rows[0];
    return row === undefined ? null : itemSchema.parse(row);
}

export async function revokeInvitation(
    tx: Transaction,
    orgId: string,
    id: string,
    nowMs: number,
): Promise<boolean> {
    const rows = await tx`
        update org_invitations set revoked_at = ${new Date(nowMs)}
        where org_id = ${orgId} and id = ${id} and accepted_at is null and revoked_at is null
        returning id
    `;
    return rows.length === 1;
}

// ---- accepting (aura_auth) ----

export async function loadVerifiedEmail(tx: Transaction, userId: string): Promise<string | null> {
    const rows = await tx`
        select email::text as email, email_verified_at from users where id = ${userId}
    `;
    const row = z
        .object({ email: z.string(), email_verified_at: z.date().nullable() })
        .parse(rows[0]);
    return row.email_verified_at === null ? null : row.email;
}

// Spends the invitation in one statement. It must match the link's hash and the accepting person's
// verified email, be pending and unexpired.
export async function consumeInvitation(
    tx: Transaction,
    input: { readonly tokenHash: string; readonly email: string; readonly nowMs: number },
): Promise<{ orgId: string; role: InvitableRole; invitedBy: string } | null> {
    const rows = await tx`
        update org_invitations set accepted_at = ${new Date(input.nowMs)}
        where token_hash = ${Buffer.from(input.tokenHash, "hex")} and email = ${input.email}
          and accepted_at is null and revoked_at is null and expires_at > ${new Date(input.nowMs)}
        returning org_id, role, invited_by
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = z
        .object({ org_id: z.string(), role: orgRoleSchema, invited_by: z.string() })
        .parse(row);
    return {
        orgId: parsed.org_id,
        role: parsed.role === "admin" ? "admin" : "member",
        invitedBy: parsed.invited_by,
    };
}

// False when the person is already a member.
export async function addMember(
    tx: Transaction,
    orgId: string,
    userId: string,
    role: InvitableRole,
): Promise<boolean> {
    const rows = await tx`
        insert into memberships (org_id, user_id, role) values (${orgId}, ${userId}, ${role})
        on conflict do nothing returning user_id
    `;
    return rows.length === 1;
}
