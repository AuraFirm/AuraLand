import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import { AUTH_METHODS, REVOKE_REASONS, type SessionRecord } from "./rules.ts";
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
