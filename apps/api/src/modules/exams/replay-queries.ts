import { EXAM_ROSTER_MAX } from "@aura/contracts/limits";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for the monitor and the replay, run as `aura_app`. The function of migration 0050 and the staff policies on
// drafts and telemetry decide who may read; anyone else gets nothing.

const monitorSchema = z.object({
    session_id: z.string(),
    email: z.string(),
    name: z.string(),
    state: z.string(),
    consented: z.boolean(),
    started_at: z.date().nullable(),
    deadline_at: z.date().nullable(),
    last_save_at: z.date().nullable(),
    saves: z.coerce.number(),
    problems_started: z.coerce.number(),
    focus_lost: z.coerce.number(),
    paste: z.coerce.number(),
    fullscreen_exit: z.coerce.number(),
    offline: z.coerce.number(),
    last_event_at: z.date().nullable(),
});
export type MonitorRow = z.infer<typeof monitorSchema>;

export async function monitorRows(tx: Transaction, examId: string): Promise<MonitorRow[]> {
    const rows = await tx`select * from exam_monitor_rows(${examId}) limit ${EXAM_ROSTER_MAX}`;
    return rows.map((row) => monitorSchema.parse(row));
}

const snapshotSchema = z.object({
    seq: z.number().int(),
    language: z.string(),
    content: z.string(),
    saved_at: z.date(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

// The snapshots of one answer from `fromSeq` on, oldest first, one more than `limit` so the caller can see if
// there is another page. Includes the snapshot at `fromSeq` itself (it is the base of the page).
export async function snapshots(
    tx: Transaction,
    input: { examId: string; sessionId: string; label: string; fromSeq: number; limit: number },
): Promise<Snapshot[]> {
    const rows = await tx`select d.seq, d.language, d.content, d.saved_at
        from exam_drafts d join exam_sessions s on s.id = d.session_id
        where s.exam_id = ${input.examId} and d.session_id = ${input.sessionId} and d.problem_label = ${input.label}
          and d.seq >= ${input.fromSeq}
        order by d.seq limit ${input.limit + 2}`;
    return rows.map((row) => snapshotSchema.parse(row));
}

const eventSchema = z.object({
    ts: z.date(),
    kind: z.string(),
    data: z.record(z.string(), z.unknown()),
});

export async function eventsBetween(
    tx: Transaction,
    input: { sessionId: string; from: Date; to: Date },
) {
    const rows = await tx`select ts, kind, data from telemetry_events
        where session_id = ${input.sessionId} and ts >= ${input.from} and ts <= ${input.to}
        order by ts, seq limit 5000`;
    return rows.map((row) => eventSchema.parse(row));
}
