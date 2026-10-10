import { LOGIN_CODE_ATTEMPTS_MAX } from "../modules/identity/limits.ts";
import type { ChallengeRecord, ChallengeStore } from "../modules/identity/login.ts";

// An in-memory ChallengeStore for simulation and unit tests. It must behave exactly like the
// PostgreSQL store (queries.ts); challenge-store.equivalence.test.ts checks that against a database.

export function createMemoryChallengeStore(): ChallengeStore & { all(): ChallengeRecord[] } {
    const byId = new Map<string, ChallengeRecord>();

    const live = (r: ChallengeRecord) => r.consumedAtMs === null;
    const findByBinding = (bindingHash: string) =>
        [...byId.values()].find((r) => r.bindingHash === bindingHash);

    return {
        all: () => [...byId.values()],
        async insert(record) {
            for (const existing of byId.values()) {
                if (
                    existing.bindingHash === record.bindingHash ||
                    existing.linkHash === record.linkHash
                ) {
                    throw new Error("duplicate challenge secret");
                }
            }
            byId.set(record.id, record);
        },
        async consumeWithLink(bindingHash, linkHash, nowMs) {
            const record = [...byId.values()].find((r) => r.linkHash === linkHash);
            if (record === undefined || record.bindingHash !== bindingHash) return null;
            if (!live(record) || nowMs >= record.linkExpiresAtMs) return null;
            byId.set(record.id, { ...record, consumedAtMs: nowMs, consumedBy: "link" });
            return { email: record.email };
        },
        async tryCode(bindingHash, codeHash, nowMs) {
            const record = findByBinding(bindingHash);
            if (record === undefined || !live(record)) return null;
            if (nowMs >= record.codeExpiresAtMs || record.codeAttempts >= LOGIN_CODE_ATTEMPTS_MAX)
                return null;
            const attempts = record.codeAttempts + 1;
            if (record.codeHash === codeHash) {
                byId.set(record.id, {
                    ...record,
                    codeAttempts: attempts,
                    consumedAtMs: nowMs,
                    consumedBy: "code",
                });
                return { consumed: true, email: record.email };
            }
            byId.set(record.id, { ...record, codeAttempts: attempts });
            return { consumed: false, attempts };
        },
    };
}
