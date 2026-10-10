import { orgRoleSchema } from "@aura/contracts/identity";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { OrgMembership } from "./authorize.ts";

// SQL for organizations and memberships. `loadMemberships` runs as `aura_auth` while a request is
// being identified; everything else runs as `aura_app` for the signed-in person, so row-level
// security decides what is visible.

// Bounded by the database rule of 20 organizations per person, with room to spare.
const MEMBERSHIPS_LIMIT = 64;

export async function loadMemberships(tx: Transaction, userId: string): Promise<OrgMembership[]> {
    const rows = await tx`
        select org_id, role from memberships where user_id = ${userId}
        order by created_at, org_id limit ${MEMBERSHIPS_LIMIT}
    `;
    return rows.map((row) => {
        const parsed = z.object({ org_id: z.string(), role: orgRoleSchema }).parse(row);
        return { orgId: parsed.org_id, role: parsed.role };
    });
}

const orgRowSchema = z.object({
    id: z.string(),
    kind: z.enum(["personal", "university", "company", "ai_lab", "community", "platform"]),
    slug: z.string(),
    name: z.string(),
    verification_state: z.enum(["unverified", "verified"]),
    data_region: z.enum(["eu", "us", "ap"]),
    created_at: z.date(),
    role: orgRoleSchema,
});
export type OrgRow = z.infer<typeof orgRowSchema>;

export async function createOrg(
    tx: Transaction,
    input: { kind: string; slug: string; name: string; region: string },
): Promise<string> {
    const rows = await tx`
        select create_org(${input.kind}, ${input.slug}, ${input.name}, ${input.region}) as id
    `;
    return z.object({ id: z.string() }).parse(rows[0]).id;
}

export async function listMyOrgs(tx: Transaction, userId: string): Promise<OrgRow[]> {
    const rows = await tx`
        select o.id, o.kind, o.slug::text as slug, o.name, o.verification_state, o.data_region,
               o.created_at, m.role
        from memberships m join orgs o on o.id = m.org_id
        where m.user_id = ${userId}
        order by o.created_at, o.id limit ${MEMBERSHIPS_LIMIT}
    `;
    return rows.map((row) => orgRowSchema.parse(row));
}

export async function getMyOrg(
    tx: Transaction,
    userId: string,
    orgId: string,
): Promise<OrgRow | null> {
    const rows = await tx`
        select o.id, o.kind, o.slug::text as slug, o.name, o.verification_state, o.data_region,
               o.created_at, m.role
        from memberships m join orgs o on o.id = m.org_id
        where m.user_id = ${userId} and o.id = ${orgId}
    `;
    const row = rows[0];
    return row === undefined ? null : orgRowSchema.parse(row);
}

export async function renameOrg(tx: Transaction, orgId: string, name: string): Promise<boolean> {
    const rows = await tx`update orgs set name = ${name} where id = ${orgId} returning id`;
    return rows.length === 1;
}

const memberRowSchema = z.object({
    user_id: z.string(),
    role: orgRoleSchema,
    created_at: z.date(),
    handle: z.string().nullable(),
    display_name: z.string().nullable(),
});
export type MemberRow = z.infer<typeof memberRowSchema>;

// Members of the organization with their profile names, where the profile policy lets the caller
// see them (people who share an organization do).
export async function listMembers(tx: Transaction, orgId: string): Promise<MemberRow[]> {
    const rows = await tx`
        select m.user_id, m.role, m.created_at, p.handle::text as handle, p.display_name
        from memberships m left join profiles p on p.user_id = m.user_id
        where m.org_id = ${orgId}
        order by m.created_at, m.user_id limit 100
    `;
    return rows.map((row) => memberRowSchema.parse(row));
}

export async function getMemberRole(
    tx: Transaction,
    orgId: string,
    userId: string,
): Promise<z.infer<typeof orgRoleSchema> | null> {
    const rows = await tx`
        select role from memberships where org_id = ${orgId} and user_id = ${userId}
    `;
    const row = rows[0];
    return row === undefined ? null : z.object({ role: orgRoleSchema }).parse(row).role;
}

export async function setMemberRole(
    tx: Transaction,
    orgId: string,
    userId: string,
    role: string,
): Promise<boolean> {
    const rows = await tx`
        update memberships set role = ${role} where org_id = ${orgId} and user_id = ${userId}
        returning user_id
    `;
    return rows.length === 1;
}

export async function removeMember(
    tx: Transaction,
    orgId: string,
    userId: string,
): Promise<boolean> {
    const rows = await tx`
        delete from memberships where org_id = ${orgId} and user_id = ${userId} returning user_id
    `;
    return rows.length === 1;
}
