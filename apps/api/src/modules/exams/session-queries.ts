import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for the candidate's own sitting, run as `aura_app`. The policy shows a person only their own session.

const rowSchema = z.object({
    exam_id: z.string(),
    state: z.enum(["invited", "consented", "started", "submitted", "expired"]),
    extra_minutes: z.number().int(),
    consent_at: z.date().nullable(),
    consent_text_version: z.number().int().nullable(),
    started_at: z.date().nullable(),
    deadline_at: z.date().nullable(),
    submitted_at: z.date().nullable(),
});
export type SessionRow = z.infer<typeof rowSchema>;

export async function getSession(tx: Transaction, examId: string): Promise<SessionRow | null> {
    const rows =
        await tx`select exam_id, state, extra_minutes, consent_at, consent_text_version, started_at,
        deadline_at, submitted_at from exam_sessions where exam_id = ${examId} and user_id = app_user()`;
    return rows[0] === undefined ? null : rowSchema.parse(rows[0]);
}

export const join = (tx: Transaction, examId: string, nowMs: number) =>
    tx`select join_exam(${examId}, ${new Date(nowMs)})`;
export const consent = (tx: Transaction, examId: string, version: number, nowMs: number) =>
    tx`select consent_exam(${examId}, ${version}, ${new Date(nowMs)})`;
export const start = (tx: Transaction, examId: string, nowMs: number) =>
    tx`select * from start_exam_session(${examId}, ${new Date(nowMs)})`;
