import { AUTH_METHODS } from "@aura/contracts/identity";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { ChallengeRecord, ChallengeStore, CodeAttempt } from "./login.ts";
import { REVOKE_REASONS, type RevokeReason, type SessionRecord } from "./rules.ts";
import type { SessionStore } from "./service.ts";

// PostgreSQL implementation of SessionStore. It must run in a transaction acting as `aura_auth`
// (the identity role), which is the only role allowed to create sessions or read token hashes.
// Times cross the boundary as milliseconds; rows are parsed so a schema drift fails loudly.

const rowSchema = z.object({
    id: z.string(),
    user_id: z.string(),
    token_hash: z.instanceof(Uint8Array),
    auth_method: z.enum(AUTH_METHODS),
    privileged: z.boolean(),
    created_at: z.date(),
    last_seen_at: z.date(),
    idle_expires_at: z.date(),
    absolute_expires_at: z.date(),
    step_up_at: z.date().nullable(),
    revoked_at: z.date().nullable(),
    revoked_reason: z.enum(REVOKE_REASONS).nullable(),
    ip_network: z.string().nullable(),
    user_agent: z.string().nullable(),
});

const statusSchema = z.enum(["active", "suspended"]);

function toRecord(row: z.infer<typeof rowSchema>): SessionRecord {
    return {
        id: row.id,
        userId: row.user_id,
        tokenHash: Buffer.from(row.token_hash).toString("hex"),
        authMethod: row.auth_method,
        privileged: row.privileged,
        createdAtMs: row.created_at.getTime(),
        lastSeenAtMs: row.last_seen_at.getTime(),
        idleExpiresAtMs: row.idle_expires_at.getTime(),
        absoluteExpiresAtMs: row.absolute_expires_at.getTime(),
        stepUpAtMs: row.step_up_at === null ? null : row.step_up_at.getTime(),
        revokedAtMs: row.revoked_at === null ? null : row.revoked_at.getTime(),
        revokedReason: row.revoked_reason,
        ipNetwork: row.ip_network,
        userAgent: row.user_agent,
    };
}

const date = (ms: number | null) => (ms === null ? null : new Date(ms));

export function createPgSessionStore(tx: Transaction): SessionStore {
    return {
        async insert(record) {
            await tx`
                insert into sessions (id, user_id, token_hash, auth_method, privileged, created_at,
                    last_seen_at, idle_expires_at, absolute_expires_at, step_up_at, revoked_at,
                    revoked_reason, ip_network, user_agent)
                values (${record.id}, ${record.userId}, ${Buffer.from(record.tokenHash, "hex")},
                    ${record.authMethod}, ${record.privileged}, ${new Date(record.createdAtMs)},
                    ${new Date(record.lastSeenAtMs)}, ${new Date(record.idleExpiresAtMs)},
                    ${new Date(record.absoluteExpiresAtMs)}, ${date(record.stepUpAtMs)},
                    ${date(record.revokedAtMs)}, ${record.revokedReason}, ${record.ipNetwork},
                    ${record.userAgent})
            `;
        },
        async findByTokenHash(tokenHash) {
            const rows = await tx`
                select s.*, u.status as user_status
                from sessions s join users u on u.id = s.user_id
                where s.token_hash = ${Buffer.from(tokenHash, "hex")}
            `;
            const row = rows[0];
            if (row === undefined) return null;
            return {
                record: toRecord(rowSchema.parse(row)),
                userStatus: statusSchema.parse(row["user_status"]),
            };
        },
        async touch(id, lastSeenAtMs, idleExpiresAtMs) {
            await tx`
                update sessions
                set last_seen_at = ${new Date(lastSeenAtMs)}, idle_expires_at = ${new Date(idleExpiresAtMs)}
                where id = ${id}
            `;
        },
        async revoke(id, atMs, reason) {
            const result = await tx`
                update sessions set revoked_at = ${new Date(atMs)}, revoked_reason = ${reason}
                where id = ${id} and revoked_at is null
            `;
            return result.count === 1;
        },
        async revokeAllForUser(userId, atMs, reason, exceptId) {
            const result = await tx`
                update sessions set revoked_at = ${new Date(atMs)}, revoked_reason = ${reason}
                where user_id = ${userId} and revoked_at is null and id is distinct from ${exceptId}
            `;
            return result.count;
        },
        async listActive(userId, nowMs) {
            const now = new Date(nowMs);
            const rows = await tx`
                select * from sessions
                where user_id = ${userId} and revoked_at is null
                  and idle_expires_at > ${now} and absolute_expires_at > ${now}
                order by created_at, id
            `;
            return rows.map((row) => toRecord(rowSchema.parse(row)));
        },
    };
}

// ---- reads and revocations for a logged-in person (run as `aura_app`) ----
// These touch only columns that role may see, never the token hash.

const meRowSchema = z.object({
    id: z.string(),
    email: z.string(),
    email_verified_at: z.date().nullable(),
    platform_role: z.enum(["none", "admin"]),
    handle: z.string().nullable(),
    display_name: z.string().nullable(),
});
export type MeRow = z.infer<typeof meRowSchema>;

export async function getMe(tx: Transaction, userId: string): Promise<MeRow | null> {
    const rows = await tx`
        select u.id, u.email, u.email_verified_at, u.platform_role, p.handle, p.display_name
        from users u left join profiles p on p.user_id = u.id
        where u.id = ${userId}
    `;
    const row = rows[0];
    return row === undefined ? null : meRowSchema.parse(row);
}

const deviceRowSchema = z.object({
    id: z.string(),
    auth_method: z.enum(AUTH_METHODS),
    created_at: z.date(),
    last_seen_at: z.date(),
    idle_expires_at: z.date(),
    absolute_expires_at: z.date(),
    ip_network: z.string().nullable(),
    user_agent: z.string().nullable(),
});
export type DeviceRow = z.infer<typeof deviceRowSchema>;

// More than the per-user maximum would be a bug, so the limit is a guard, not a feature.
const DEVICE_LIST_LIMIT = 50;

export async function listDevices(
    tx: Transaction,
    userId: string,
    nowMs: number,
): Promise<DeviceRow[]> {
    const now = new Date(nowMs);
    const rows = await tx`
        select id, auth_method, created_at, last_seen_at, idle_expires_at, absolute_expires_at,
               ip_network, user_agent
        from sessions
        where user_id = ${userId} and revoked_at is null
          and idle_expires_at > ${now} and absolute_expires_at > ${now}
        order by created_at desc, id desc
        limit ${DEVICE_LIST_LIMIT}
    `;
    return rows.map((row) => deviceRowSchema.parse(row));
}

// The caller's own session only: the `user_id` condition here and the row-level security policy
// each refuse another person's session independently.
export async function revokeOwnSession(
    tx: Transaction,
    userId: string,
    sessionId: string,
    atMs: number,
    reason: RevokeReason,
): Promise<boolean> {
    const result = await tx`
        update sessions set revoked_at = ${new Date(atMs)}, revoked_reason = ${reason}
        where id = ${sessionId} and user_id = ${userId} and revoked_at is null
    `;
    return result.count === 1;
}

export async function revokeAllOwnSessions(
    tx: Transaction,
    userId: string,
    atMs: number,
    reason: RevokeReason,
): Promise<number> {
    const result = await tx`
        update sessions set revoked_at = ${new Date(atMs)}, revoked_reason = ${reason}
        where user_id = ${userId} and revoked_at is null
    `;
    return result.count;
}

// ---- email sign-in challenges (run as `aura_auth`) ----

const challengeRowSchema = z.object({
    id: z.string(),
    email: z.string(),
    binding_hash: z.instanceof(Uint8Array),
    link_hash: z.instanceof(Uint8Array),
    code_hash: z.instanceof(Uint8Array),
    created_at: z.date(),
    link_expires_at: z.date(),
    code_expires_at: z.date(),
    code_attempts: z.number().int(),
    consumed_at: z.date().nullable(),
    consumed_by: z.enum(["link", "code"]).nullable(),
});

const consumedEmailSchema = z.object({ email: z.string() });
const attemptSchema = z.object({
    email: z.string(),
    code_attempts: z.number().int(),
    consumed: z.boolean(),
});

const hex = (value: string) => Buffer.from(value, "hex");

// Each method is one SQL statement, so the check and the change cannot be separated by another
// request: two simultaneous guesses each spend an attempt, and a challenge is consumed once.
export function createPgChallengeStore(tx: Transaction, maxAttempts: number): ChallengeStore {
    return {
        async insert(record: ChallengeRecord) {
            await tx`
                insert into login_challenges (id, email, binding_hash, link_hash, code_hash, created_at,
                    link_expires_at, code_expires_at, code_attempts, consumed_at, consumed_by)
                values (${record.id}, ${record.email}, ${hex(record.bindingHash)}, ${hex(record.linkHash)},
                    ${hex(record.codeHash)}, ${new Date(record.createdAtMs)},
                    ${new Date(record.linkExpiresAtMs)}, ${new Date(record.codeExpiresAtMs)},
                    ${record.codeAttempts}, ${date(record.consumedAtMs)}, ${record.consumedBy})
            `;
        },
        async consumeWithLink(bindingHash, linkHash, nowMs) {
            const now = new Date(nowMs);
            const rows = await tx`
                update login_challenges set consumed_at = ${now}, consumed_by = 'link'
                where link_hash = ${hex(linkHash)} and binding_hash = ${hex(bindingHash)}
                  and consumed_at is null and link_expires_at > ${now}
                returning email
            `;
            const row = rows[0];
            return row === undefined ? null : consumedEmailSchema.parse(row);
        },
        async tryCode(bindingHash, codeHash, nowMs): Promise<CodeAttempt | null> {
            const now = new Date(nowMs);
            const rows = await tx`
                update login_challenges
                set code_attempts = code_attempts + 1,
                    consumed_at = case when code_hash = ${hex(codeHash)} then ${now} end,
                    consumed_by = case when code_hash = ${hex(codeHash)} then 'code' end
                where binding_hash = ${hex(bindingHash)} and consumed_at is null
                  and code_expires_at > ${now} and code_attempts < ${maxAttempts}
                returning email, code_attempts, consumed_at is not null as consumed
            `;
            const row = rows[0];
            if (row === undefined) return null;
            const parsed = attemptSchema.parse(row);
            return parsed.consumed
                ? { consumed: true, email: parsed.email }
                : { consumed: false, attempts: parsed.code_attempts };
        },
    };
}

// Used by tests to compare stored state with the in-memory store.
export async function readChallenges(tx: Transaction): Promise<ChallengeRecord[]> {
    const rows = await tx`select * from login_challenges order by created_at, id`;
    return rows.map((raw) => {
        const row = challengeRowSchema.parse(raw);
        return {
            id: row.id,
            email: row.email,
            bindingHash: Buffer.from(row.binding_hash).toString("hex"),
            linkHash: Buffer.from(row.link_hash).toString("hex"),
            codeHash: Buffer.from(row.code_hash).toString("hex"),
            createdAtMs: row.created_at.getTime(),
            linkExpiresAtMs: row.link_expires_at.getTime(),
            codeExpiresAtMs: row.code_expires_at.getTime(),
            codeAttempts: row.code_attempts,
            consumedAtMs: row.consumed_at === null ? null : row.consumed_at.getTime(),
            consumedBy: row.consumed_by,
        };
    });
}
