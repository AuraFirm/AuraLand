import { encodeId } from "@aura/contracts/ids";
import { EXAM_JUDGE_QUEUE_READY_MAX } from "@aura/contracts/limits";
import { appendAudit } from "@aura/db/audit";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { Clock } from "../../platform/clock.ts";

export interface TickContext {
    readonly clock: Clock;
    readonly inTransaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
}

// The exam clock (Stage 6): once a second the worker moves every exam the time has passed and expires every
// sitting past its deadline. One batch each, idempotent, so any number of workers may tick and a missed
// exam catches up through every state. The deadline itself is enforced by the functions that take saves
// (with the clock), not by this tick: a stopped worker must not extend an exam.

export const EXAM_TICK_MS = 1_000;

const moveSchema = z.object({ exam_id: z.string(), from_state: z.string(), to_state: z.string() });

// Returns how many state changes and expiries were made; each state change is in the audit trail.
export async function advanceExams(context: TickContext): Promise<number> {
    const now = new Date(context.clock.nowUnixMs());
    return context.inTransaction(async (tx) => {
        const moves = await tx`select exam_id, from_state, to_state from advance_exams(${now})`;
        for (const row of moves) {
            const move = moveSchema.parse(row);
            await appendAudit(tx, {
                actorKind: "worker",
                actorUserId: null,
                orgId: null,
                action: "exam.state_changed",
                target: encodeId("exm", move.exam_id),
                detail: { from: move.from_state, to: move.to_state },
            });
        }
        const expired = await tx`select advance_exam_sessions(${now}) as n`;
        // Answers of sittings that are over go to the judge (priority between contests and practice).
        const queued =
            await tx`select queue_exam_answers(${now}, ${EXAM_JUDGE_QUEUE_READY_MAX}) as n`;
        const count = z.object({ n: z.number() });
        return moves.length + count.parse(expired[0]).n + count.parse(queued[0]).n;
    });
}
