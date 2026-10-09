import { assert } from "@aura/contracts/assert";
import { type AuditEntryInput, auditEntrySchema } from "@aura/contracts/audit";
import type { Sql } from "./client.ts";
import type { Transaction } from "./context.ts";

// Writing to and checking the append-only audit log. The hash chain itself lives in the database
// (migration 0004), where no application code path can skip it.

export type { AuditEntry } from "@aura/contracts/audit";

export interface AuditHead {
    readonly seq: string; // bigint as text, because JavaScript numbers lose precision above 2^53
    readonly hash: string; // lowercase hexadecimal
}

export type AuditVerification =
    | { readonly ok: true; readonly head: AuditHead | null }
    | { readonly ok: false; readonly reason: "broken_chain"; readonly firstBadSeq: string }
    | { readonly ok: false; readonly reason: "truncated" };

// Validates the entry again (the caller may have built it by hand), then inserts it. The database
// trigger fills in the sequence number and both hashes, and row-level security decides whether
// this role may log this actor.
export async function appendAudit(transaction: Transaction, input: AuditEntryInput): Promise<void> {
    const entry = auditEntrySchema.parse(input);
    await transaction`
        insert into audit_log (actor_user_id, actor_kind, org_id, action, target, ip, detail)
        values (${entry.actorUserId}, ${entry.actorKind}, ${entry.orgId}, ${entry.action},
                ${entry.target}, ${entry.ip}, ${transaction.json(entry.detail)})
    `;
}

// Recomputes every hash and link. With `expectedHead` (kept somewhere the database cannot reach),
// it also detects removal of the newest rows, which the chain alone cannot show.
export async function verifyAuditChain(
    sql: Sql,
    options: { readonly expectedHead?: AuditHead } = {},
): Promise<AuditVerification> {
    const [bad] = await sql<{ seq: string | null }[]>`select audit_chain_first_bad() as seq`;
    if (bad?.seq !== null && bad?.seq !== undefined) {
        return { ok: false, reason: "broken_chain", firstBadSeq: bad.seq };
    }
    const [row] = await sql<
        { seq: string; hash: Uint8Array }[]
    >`select seq, hash from audit_chain_head()`;
    const head: AuditHead | null =
        row === undefined ? null : { seq: row.seq, hash: Buffer.from(row.hash).toString("hex") };
    const expected = options.expectedHead;
    if (expected !== undefined) {
        assert(/^[0-9]+$/.test(expected.seq), "expected head seq is a decimal number");
        if (head === null || BigInt(head.seq) < BigInt(expected.seq))
            return { ok: false, reason: "truncated" };
    }
    return { ok: true, head };
}
