import type { RevokeReason, SessionRecord, UserStatus } from "../modules/identity/rules.ts";
import type { SessionStore } from "../modules/identity/service.ts";

// An in-memory SessionStore for simulation and unit tests. It must behave exactly like the
// PostgreSQL store (queries.ts); session-store.equivalence.test.ts checks that against a database.

export function createMemorySessionStore(
    statusOf: (userId: string) => UserStatus,
): SessionStore & { all(): SessionRecord[] } {
    const byId = new Map<string, SessionRecord>();

    const isActive = (record: SessionRecord, nowMs: number) =>
        record.revokedAtMs === null &&
        nowMs < record.idleExpiresAtMs &&
        nowMs < record.absoluteExpiresAtMs;

    function replace(id: string, change: Partial<SessionRecord>): void {
        const record = byId.get(id);
        if (record !== undefined) byId.set(id, { ...record, ...change });
    }

    return {
        all: () => [...byId.values()],
        async insert(record) {
            for (const existing of byId.values()) {
                if (existing.tokenHash === record.tokenHash)
                    throw new Error("duplicate token hash");
            }
            if (byId.has(record.id)) throw new Error("duplicate session id");
            byId.set(record.id, record);
        },
        async findByTokenHash(tokenHash) {
            for (const record of byId.values()) {
                if (record.tokenHash === tokenHash)
                    return { record, userStatus: statusOf(record.userId) };
            }
            return null;
        },
        async touch(id, lastSeenAtMs, idleExpiresAtMs) {
            replace(id, { lastSeenAtMs, idleExpiresAtMs });
        },
        async revoke(id, atMs, reason: RevokeReason) {
            const record = byId.get(id);
            if (record === undefined || record.revokedAtMs !== null) return false;
            replace(id, { revokedAtMs: atMs, revokedReason: reason });
            return true;
        },
        async revokeAllForUser(userId, atMs, reason, exceptId) {
            let count = 0;
            for (const record of [...byId.values()]) {
                if (
                    record.userId !== userId ||
                    record.revokedAtMs !== null ||
                    record.id === exceptId
                )
                    continue;
                replace(record.id, { revokedAtMs: atMs, revokedReason: reason });
                count++;
            }
            return count;
        },
        async listActive(userId, nowMs) {
            return [...byId.values()]
                .filter((record) => record.userId === userId && isActive(record, nowMs))
                .sort(
                    (a, b) =>
                        a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
                );
        },
    };
}
