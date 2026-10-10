import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { UserStatus } from "./rules.ts";

// SQL for passkeys and their challenges. Verification-side functions run as `aura_auth`; the three
// "own" functions at the end run as `aura_app` for the signed-in person and see no key material.

export type ChallengePurpose = "register" | "login";

export const TRANSPORTS = ["usb", "nfc", "ble", "hybrid", "internal", "smart-card"] as const;
const transportSet: ReadonlySet<string> = new Set(TRANSPORTS);

// Browsers may report transports we do not know; only the ones the database allows are kept.
export function knownTransports(reported: readonly string[] | undefined): string[] {
    return (reported ?? []).filter((transport) => transportSet.has(transport));
}

export async function insertChallenge(
    tx: Transaction,
    input: {
        readonly challenge: string;
        readonly purpose: ChallengePurpose;
        readonly userId: string | null;
        readonly nowMs: number;
        readonly ttlS: number;
    },
): Promise<string> {
    const rows = await tx`
        insert into webauthn_challenges (challenge, purpose, user_id, created_at, expires_at)
        values (${input.challenge}, ${input.purpose}, ${input.userId}, ${new Date(input.nowMs)},
                ${new Date(input.nowMs + input.ttlS * 1000)})
        returning id
    `;
    return z.object({ id: z.string() }).parse(rows[0]).id;
}

const spentSchema = z.object({ challenge: z.string(), user_id: z.string().nullable() });

// Spends the challenge in one statement, so two simultaneous answers cannot both use it. Null when
// it does not exist, was already used, has expired or was made for another purpose.
export async function consumeChallenge(
    tx: Transaction,
    id: string,
    purpose: ChallengePurpose,
    nowMs: number,
): Promise<{ challenge: string; userId: string | null } | null> {
    const rows = await tx`
        update webauthn_challenges set consumed_at = ${new Date(nowMs)}
        where id = ${id} and purpose = ${purpose} and consumed_at is null
          and expires_at > ${new Date(nowMs)}
        returning challenge, user_id
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = spentSchema.parse(row);
    return { challenge: parsed.challenge, userId: parsed.user_id };
}

export async function listCredentialsOf(
    tx: Transaction,
    userId: string,
): Promise<Array<{ id: string; transports: string[] }>> {
    const rows = await tx`
        select credential_id, transports from passkeys where user_id = ${userId}
        order by created_at, id limit 20
    `;
    return rows.map((row) => {
        const parsed = z
            .object({ credential_id: z.instanceof(Uint8Array), transports: z.array(z.string()) })
            .parse(row);
        return {
            id: Buffer.from(parsed.credential_id).toString("base64url"),
            transports: parsed.transports,
        };
    });
}

export async function countPasskeys(tx: Transaction, userId: string): Promise<number> {
    const rows = await tx`select count(*)::int as n from passkeys where user_id = ${userId}`;
    return z.object({ n: z.number() }).parse(rows[0]).n;
}

export interface NewPasskey {
    readonly userId: string;
    readonly credentialId: Buffer;
    readonly publicKey: Buffer;
    readonly counter: number;
    readonly transports: string[];
    readonly deviceType: "singleDevice" | "multiDevice";
    readonly backedUp: boolean;
    readonly name: string;
}

// Null when this credential is already registered (by anyone): a client may ignore the exclude list.
export async function insertPasskey(tx: Transaction, passkey: NewPasskey): Promise<string | null> {
    const rows = await tx`
        insert into passkeys (user_id, credential_id, public_key, counter, transports, device_type,
                              backed_up, name)
        values (${passkey.userId}, ${passkey.credentialId}, ${passkey.publicKey}, ${passkey.counter},
                ${passkey.transports}, ${passkey.deviceType}, ${passkey.backedUp}, ${passkey.name})
        on conflict (credential_id) do nothing
        returning id
    `;
    const row = rows[0];
    return row === undefined ? null : z.object({ id: z.string() }).parse(row).id;
}

export interface StoredPasskey {
    readonly id: string;
    readonly userId: string;
    readonly publicKey: Uint8Array;
    readonly counter: number;
    readonly transports: string[];
    readonly userStatus: UserStatus;
}

const storedSchema = z.object({
    id: z.string(),
    user_id: z.string(),
    public_key: z.instanceof(Uint8Array),
    counter: z.coerce.number(),
    transports: z.array(z.string()),
    status: z.enum(["active", "suspended"]),
});

export async function findPasskey(
    tx: Transaction,
    credentialId: Buffer,
): Promise<StoredPasskey | null> {
    const rows = await tx`
        select p.id, p.user_id, p.public_key, p.counter, p.transports, u.status
        from passkeys p join users u on u.id = p.user_id
        where p.credential_id = ${credentialId}
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const parsed = storedSchema.parse(row);
    return {
        id: parsed.id,
        userId: parsed.user_id,
        publicKey: parsed.public_key,
        counter: parsed.counter,
        transports: parsed.transports,
        userStatus: parsed.status,
    };
}

export async function recordPasskeyUse(
    tx: Transaction,
    id: string,
    use: { readonly counter: number; readonly backedUp: boolean; readonly nowMs: number },
): Promise<void> {
    await tx`
        update passkeys set counter = ${use.counter}, backed_up = ${use.backedUp},
            last_used_at = ${new Date(use.nowMs)}
        where id = ${id}
    `;
}

// ---- as the signed-in person (aura_app) ----

const itemSchema = z.object({
    id: z.string(),
    name: z.string(),
    created_at: z.date(),
    last_used_at: z.date().nullable(),
    transports: z.array(z.string()),
    device_type: z.enum(["singleDevice", "multiDevice"]),
    backed_up: z.boolean(),
});
export type PasskeyRow = z.infer<typeof itemSchema>;

export async function listOwnPasskeys(tx: Transaction): Promise<PasskeyRow[]> {
    // Row-level security limits this to the caller's own rows; the column list hides key material.
    const rows = await tx`
        select id, name, created_at, last_used_at, transports, device_type, backed_up
        from passkeys order by created_at, id limit 20
    `;
    return rows.map((row) => itemSchema.parse(row));
}

export async function renameOwnPasskey(
    tx: Transaction,
    id: string,
    name: string,
): Promise<boolean> {
    const rows = await tx`update passkeys set name = ${name} where id = ${id} returning id`;
    return rows.length === 1;
}

export async function deleteOwnPasskey(tx: Transaction, id: string): Promise<boolean> {
    const rows = await tx`delete from passkeys where id = ${id} returning id`;
    return rows.length === 1;
}
