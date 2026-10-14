import { nodeStateSchema } from "@aura/contracts/judge-protocol";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for judge nodes, run as `aura_worker` (the API acts for a node after checking its signature).

const nodeRowSchema = z.object({
    id: z.string(),
    name: z.string(),
    public_key: z.instanceof(Uint8Array),
    state: nodeStateSchema,
});
export type NodeRow = z.infer<typeof nodeRowSchema>;

export async function findNode(tx: Transaction, id: string): Promise<NodeRow | null> {
    const rows = await tx`select id, name, public_key, state from judge_nodes where id = ${id}`;
    return rows[0] === undefined ? null : nodeRowSchema.parse(rows[0]);
}

// True the first time a nonce is seen for a node; false for a replay.
export async function recordNonce(
    tx: Transaction,
    nodeId: string,
    nonce: Buffer,
    nowMs: number,
): Promise<boolean> {
    const rows = await tx`
        insert into node_nonces (node_id, nonce, seen_at) values (${nodeId}, ${nonce}, ${new Date(nowMs)})
        on conflict do nothing returning nonce`;
    return rows.length === 1;
}

export type EnrollResult =
    | { readonly kind: "enrolled"; readonly id: string }
    | { readonly kind: "invalid_token" }
    | { readonly kind: "conflict" };

// Spends the single-use token and creates the node in one step. The token row is locked first, so two
// simultaneous uses of one token cannot both succeed.
export async function enrollNode(
    tx: Transaction,
    input: {
        tokenHash: Buffer;
        name: string;
        publicKey: Buffer;
        agentVersion: string;
        tiers: number[];
        nowMs: number;
    },
): Promise<EnrollResult> {
    const at = new Date(input.nowMs);
    const tokens = await tx`
        select id, attestation from node_enrollments
        where token_hash = ${input.tokenHash} and used_at is null and expires_at > ${at} for update`;
    if (tokens[0] === undefined) return { kind: "invalid_token" };
    const token = z.object({ id: z.string(), attestation: z.string() }).parse(tokens[0]);
    const tokenId = token.id;
    const taken =
        await tx`select 1 from judge_nodes where name = ${input.name} or public_key = ${input.publicKey}`;
    if (taken.length > 0) return { kind: "conflict" };
    const created = await tx`
        insert into judge_nodes (name, public_key, tiers, agent_version, attestation, created_at, last_seen_at)
        values (${input.name}, ${input.publicKey}, ${input.tiers}, ${input.agentVersion}, ${token.attestation}, ${at}, ${at}) returning id`;
    const id = z.object({ id: z.string() }).parse(created[0]).id;
    await tx`update node_enrollments set used_at = ${at}, used_by = ${id} where id = ${tokenId}`;
    return { kind: "enrolled", id };
}

// Records a heartbeat and applies the state rules: the first passing self-test activates an enrolled
// node, and a failing one drains an active node. Revoked nodes never reach this point.
export async function recordHeartbeat(
    tx: Transaction,
    id: string,
    input: { agentVersion: string; canaryOk: boolean; nowMs: number },
): Promise<z.infer<typeof nodeStateSchema>> {
    const at = new Date(input.nowMs);
    const rows = await tx`
        update judge_nodes set
            last_seen_at = ${at},
            agent_version = ${input.agentVersion},
            canary_ok_at = case when ${input.canaryOk} then ${at} else canary_ok_at end,
            state = case
                when state = 'enrolled' and ${input.canaryOk} then 'active'
                when state = 'active' and not ${input.canaryOk} then 'draining'
                when state = 'draining' and ${input.canaryOk} then 'active'
                else state end
        where id = ${id} returning state`;
    return z.object({ state: nodeStateSchema }).parse(rows[0]).state;
}
