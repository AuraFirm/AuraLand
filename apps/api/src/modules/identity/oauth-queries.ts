import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { ProviderName } from "./oauth-providers.ts";
import type { UserStatus } from "./rules.ts";

// SQL for OAuth sign-in. The first group runs as `aura_auth`; the last two functions run as
// `aura_app` for the signed-in person and never see the provider's user id.

export type FlowPurpose = "login" | "link";

export async function insertFlow(
    tx: Transaction,
    input: {
        readonly provider: ProviderName;
        readonly purpose: FlowPurpose;
        readonly userId: string | null;
        readonly stateHash: string;
        readonly verifierHash: string;
        readonly nowMs: number;
        readonly ttlS: number;
    },
): Promise<void> {
    await tx`
        insert into oauth_flows (provider, purpose, user_id, state_hash, verifier_hash, created_at,
                                 expires_at)
        values (${input.provider}, ${input.purpose}, ${input.userId},
                ${Buffer.from(input.stateHash, "hex")}, ${Buffer.from(input.verifierHash, "hex")},
                ${new Date(input.nowMs)}, ${new Date(input.nowMs + input.ttlS * 1000)})
    `;
}

const flowSchema = z.object({ purpose: z.enum(["login", "link"]), user_id: z.string().nullable() });

// Spends the flow in one statement. It must match the state from the redirect, the verifier from the
// browser's cookie and the provider named in the URL, and be unused and unexpired.
export async function consumeFlow(
    tx: Transaction,
    input: {
        readonly provider: ProviderName;
        readonly stateHash: string;
        readonly verifierHash: string;
        readonly nowMs: number;
    },
): Promise<{ purpose: FlowPurpose; userId: string | null } | null> {
    const rows = await tx`
        update oauth_flows set consumed_at = ${new Date(input.nowMs)}
        where state_hash = ${Buffer.from(input.stateHash, "hex")}
          and verifier_hash = ${Buffer.from(input.verifierHash, "hex")}
          and provider = ${input.provider} and consumed_at is null
          and expires_at > ${new Date(input.nowMs)}
        returning purpose, user_id
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = flowSchema.parse(row);
    return { purpose: parsed.purpose, userId: parsed.user_id };
}

export interface FoundIdentity {
    readonly id: string;
    readonly userId: string;
    readonly userStatus: UserStatus;
}

const foundSchema = z.object({
    id: z.string(),
    user_id: z.string(),
    status: z.enum(["active", "suspended"]),
});

export async function findIdentity(
    tx: Transaction,
    provider: ProviderName,
    providerUserId: string,
): Promise<FoundIdentity | null> {
    const rows = await tx`
        select i.id, i.user_id, u.status
        from oauth_identities i join users u on u.id = i.user_id
        where i.provider = ${provider} and i.provider_user_id = ${providerUserId}
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = foundSchema.parse(row);
    return { id: parsed.id, userId: parsed.user_id, userStatus: parsed.status };
}

// False when this provider identity, or this provider for this person, is already linked.
export async function insertIdentity(
    tx: Transaction,
    input: {
        readonly userId: string;
        readonly provider: ProviderName;
        readonly providerUserId: string;
        readonly email: string | null;
    },
): Promise<boolean> {
    const rows = await tx`
        insert into oauth_identities (user_id, provider, provider_user_id, email_at_link)
        values (${input.userId}, ${input.provider}, ${input.providerUserId}, ${input.email})
        on conflict do nothing
        returning id
    `;
    return rows.length === 1;
}

export async function touchIdentity(tx: Transaction, id: string, nowMs: number): Promise<void> {
    await tx`update oauth_identities set last_login_at = ${new Date(nowMs)} where id = ${id}`;
}

export async function findUserIdByEmail(tx: Transaction, email: string): Promise<string | null> {
    const rows = await tx`select id from users where email = ${email}`;
    const row = rows[0];
    return row === undefined ? null : z.object({ id: z.string() }).parse(row).id;
}

export async function findUserStatus(tx: Transaction, userId: string): Promise<UserStatus | null> {
    const rows = await tx`select status from users where id = ${userId}`;
    const row = rows[0];
    return row === undefined
        ? null
        : z.object({ status: z.enum(["active", "suspended"]) }).parse(row).status;
}

// ---- as the signed-in person (aura_app) ----

const itemSchema = z.object({
    provider: z.enum(["github", "google"]),
    email_at_link: z.string().nullable(),
    created_at: z.date(),
    last_login_at: z.date().nullable(),
});
export type IdentityRow = z.infer<typeof itemSchema>;

export async function listOwnIdentities(tx: Transaction): Promise<IdentityRow[]> {
    // Row-level security limits this to the caller's rows; the column list hides the provider id.
    const rows = await tx`
        select provider, email_at_link::text as email_at_link, created_at, last_login_at
        from oauth_identities order by provider limit 10
    `;
    return rows.map((row) => itemSchema.parse(row));
}

export async function deleteOwnIdentity(tx: Transaction, provider: ProviderName): Promise<boolean> {
    const rows = await tx`delete from oauth_identities where provider = ${provider} returning id`;
    return rows.length === 1;
}
