import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for signing in through an organization's identity provider. Runs as `aura_auth`.

export async function orgForEmail(tx: Transaction, email: string): Promise<string | null> {
    const [row] = await tx`select sso_org_for_email(${email}) as org`;
    return z.object({ org: z.string().nullable() }).parse(row).org;
}

const connectionRow = z.object({
    issuer: z.string(),
    client_id: z.string(),
    client_secret: z.string(),
    authorization_endpoint: z.string(),
    token_endpoint: z.string(),
    jwks_uri: z.string(),
});
export type Connection = z.infer<typeof connectionRow>;

export async function connectionOf(tx: Transaction, org: string): Promise<Connection | null> {
    const [row] =
        await tx`select issuer, client_id, client_secret, authorization_endpoint, token_endpoint, jwks_uri
        from sso_connections where org_id = ${org}`;
    return row === undefined ? null : connectionRow.parse(row);
}

export async function verifiedDomains(tx: Transaction, org: string): Promise<string[]> {
    const rows =
        await tx`select domain from sso_domains where org_id = ${org} and verified_at is not null limit 20`;
    return rows.map((row) => z.object({ domain: z.string() }).parse(row).domain);
}

export async function insertSsoFlow(
    tx: Transaction,
    input: {
        org: string;
        stateHash: string;
        verifierHash: string;
        nonce: string;
        nowMs: number;
        ttlS: number;
    },
): Promise<void> {
    await tx`insert into sso_flows (org_id, state_hash, verifier_hash, nonce, created_at, expires_at)
        values (${input.org}, ${Buffer.from(input.stateHash, "hex")}, ${Buffer.from(input.verifierHash, "hex")}, ${input.nonce},
                ${new Date(input.nowMs)}, ${new Date(input.nowMs + input.ttlS * 1000)})`;
}

// Spends the flow in one statement: the state from the redirect, the verifier from the browser's cookie, unused and unexpired.
export async function consumeSsoFlow(
    tx: Transaction,
    input: { stateHash: string; verifierHash: string; nowMs: number },
): Promise<{ org: string; nonce: string } | null> {
    const [row] = await tx`update sso_flows set consumed_at = ${new Date(input.nowMs)}
        where state_hash = ${Buffer.from(input.stateHash, "hex")} and verifier_hash = ${Buffer.from(input.verifierHash, "hex")}
          and consumed_at is null and expires_at > ${new Date(input.nowMs)}
        returning org_id, nonce`;
    if (row === undefined) return null;
    const parsed = z.object({ org_id: z.string(), nonce: z.string() }).parse(row);
    return { org: parsed.org_id, nonce: parsed.nonce };
}

export async function findSsoIdentity(tx: Transaction, org: string, subject: string) {
    const [row] =
        await tx`select i.user_id, u.status from sso_identities i join users u on u.id = i.user_id
        where i.org_id = ${org} and i.subject = ${subject}`;
    if (row === undefined) return null;
    const parsed = z.object({ user_id: z.string(), status: z.string() }).parse(row);
    return { userId: parsed.user_id, status: parsed.status };
}

export async function insertSsoIdentity(
    tx: Transaction,
    input: { org: string; subject: string; userId: string; nowMs: number },
): Promise<boolean> {
    const rows =
        await tx`insert into sso_identities (org_id, subject, user_id, created_at, last_login_at)
        values (${input.org}, ${input.subject}, ${input.userId}, ${new Date(input.nowMs)}, ${new Date(input.nowMs)})
        on conflict do nothing returning user_id`;
    return rows.length === 1;
}

export async function touchSsoIdentity(
    tx: Transaction,
    org: string,
    subject: string,
    nowMs: number,
): Promise<void> {
    await tx`update sso_identities set last_login_at = ${new Date(nowMs)} where org_id = ${org} and subject = ${subject}`;
}

export async function joinOrg(
    tx: Transaction,
    org: string,
    userId: string,
): Promise<"member" | "joined" | "full"> {
    const [row] = await tx`select sso_join_org(${org}, ${userId}) as result`;
    return z.object({ result: z.enum(["member", "joined", "full"]) }).parse(row).result;
}

// True when this way of signing in is not allowed for this person because their organization requires SSO.
export async function ssoBlocks(tx: Transaction, userId: string, method: string): Promise<boolean> {
    const [row] = await tx`select sso_blocks_sign_in(${userId}, ${method}) as blocked`;
    return z.object({ blocked: z.boolean() }).parse(row).blocked;
}

export async function orgHasRoom(tx: Transaction, org: string): Promise<boolean> {
    const [row] = await tx`select sso_org_has_room(${org}) as room`;
    return z.object({ room: z.boolean() }).parse(row).room;
}
