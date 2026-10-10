import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for API keys. `findKeyByPrefix` and `touchKey` run as `aura_auth` while a request is being
// identified; the rest run as `aura_app` for an owner or admin, and never see a hash.

export async function insertApiKey(
    tx: Transaction,
    input: {
        readonly orgId: string;
        readonly name: string;
        readonly prefix: string;
        readonly secretHash: string;
        readonly scopes: readonly string[];
        readonly createdBy: string;
        readonly expiresAtMs: number;
    },
): Promise<string> {
    const rows = await tx`
        insert into api_keys (org_id, name, prefix, secret_hash, scopes, created_by, expires_at)
        values (${input.orgId}, ${input.name}, ${input.prefix},
                ${Buffer.from(input.secretHash, "hex")}, ${[...input.scopes]}, ${input.createdBy},
                ${new Date(input.expiresAtMs)})
        returning id
    `;
    return z.object({ id: z.string() }).parse(rows[0]).id;
}

const itemSchema = z.object({
    id: z.string(),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(z.string()),
    created_at: z.date(),
    expires_at: z.date(),
    revoked_at: z.date().nullable(),
    last_used_at: z.date().nullable(),
});
export type ApiKeyRow = z.infer<typeof itemSchema>;

export async function listApiKeys(tx: Transaction, orgId: string): Promise<ApiKeyRow[]> {
    const rows = await tx`
        select id, name, prefix, scopes, created_at, expires_at, revoked_at, last_used_at
        from api_keys where org_id = ${orgId} order by created_at, id limit 100
    `;
    return rows.map((row) => itemSchema.parse(row));
}

export async function getApiKey(
    tx: Transaction,
    orgId: string,
    keyId: string,
): Promise<ApiKeyRow | null> {
    const rows = await tx`
        select id, name, prefix, scopes, created_at, expires_at, revoked_at, last_used_at
        from api_keys where org_id = ${orgId} and id = ${keyId}
    `;
    const row = rows[0];
    return row === undefined ? null : itemSchema.parse(row);
}

// True only if the key was live and is now revoked (revoking twice changes nothing).
export async function revokeApiKey(
    tx: Transaction,
    orgId: string,
    keyId: string,
    nowMs: number,
): Promise<boolean> {
    const rows = await tx`
        update api_keys set revoked_at = ${new Date(nowMs)}
        where org_id = ${orgId} and id = ${keyId} and revoked_at is null returning id
    `;
    return rows.length === 1;
}

export interface KeyRecord {
    readonly id: string;
    readonly orgId: string;
    readonly secretHash: string;
    readonly scopes: readonly string[];
    readonly expiresAtMs: number;
    readonly revoked: boolean;
    readonly lastUsedAtMs: number | null;
}

const recordSchema = z.object({
    id: z.string(),
    org_id: z.string(),
    secret_hash: z.instanceof(Uint8Array),
    scopes: z.array(z.string()),
    expires_at: z.date(),
    revoked_at: z.date().nullable(),
    last_used_at: z.date().nullable(),
});

export async function findKeyByPrefix(tx: Transaction, prefix: string): Promise<KeyRecord | null> {
    const rows = await tx`
        select id, org_id, secret_hash, scopes, expires_at, revoked_at, last_used_at
        from api_keys where prefix = ${prefix}
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = recordSchema.parse(row);
    return {
        id: parsed.id,
        orgId: parsed.org_id,
        secretHash: Buffer.from(parsed.secret_hash).toString("hex"),
        scopes: parsed.scopes,
        expiresAtMs: parsed.expires_at.getTime(),
        revoked: parsed.revoked_at !== null,
        lastUsedAtMs: parsed.last_used_at === null ? null : parsed.last_used_at.getTime(),
    };
}

export async function touchKey(tx: Transaction, keyId: string, nowMs: number): Promise<void> {
    await tx`update api_keys set last_used_at = ${new Date(nowMs)} where id = ${keyId}`;
}
