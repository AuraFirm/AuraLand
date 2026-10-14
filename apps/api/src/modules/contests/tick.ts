import { encodeId } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { Clock } from "../../platform/clock.ts";

// The contest clock (Stage 5): once a second the worker asks the database to move every contest the time
// has passed. One batch, not one reaction per contest (docs/kit/02, "run at your own pace"); idempotent,
// so any number of workers may tick, and a contest the worker missed catches up through every state.

export const CONTEST_TICK_MS = 1_000;

export interface TickContext {
    readonly clock: Clock;
    readonly inTransaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
}

const moveSchema = z.object({
    contest_id: z.string(),
    from_state: z.string(),
    to_state: z.string(),
});

// Returns how many state changes were made; each is in the audit trail.
export async function advanceContests(context: TickContext): Promise<number> {
    const now = new Date(context.clock.nowUnixMs());
    return context.inTransaction(async (tx) => {
        const rows =
            await tx`select contest_id, from_state, to_state from advance_contests(${now})`;
        for (const row of rows) {
            const move = moveSchema.parse(row);
            await appendAudit(tx, {
                actorKind: "worker",
                actorUserId: null,
                orgId: null,
                action: "contest.state_changed",
                target: encodeId("cst", move.contest_id),
                detail: { from: move.from_state, to: move.to_state },
            });
        }
        return rows.length;
    });
}
