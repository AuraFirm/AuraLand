import type { TelemetryEvent } from "@aura/contracts/exams";
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
export const submit = (tx: Transaction, examId: string, nowMs: number) =>
    tx`select submit_exam_session(${examId}, ${new Date(nowMs)})`;
export type TelemetryResult =
    | { readonly kind: "accepted"; readonly events: number }
    | {
          readonly kind: "refused";
          readonly why: "unknown" | "no_consent" | "not_under_way" | "too_many" | "bad_batch";
      };

const TELEMETRY_REFUSALS: Readonly<
    Record<string, "unknown" | "no_consent" | "not_under_way" | "too_many" | "bad_batch">
> = {
    P0002: "unknown",
    "42501": "no_consent",
    "55000": "not_under_way",
    "54000": "too_many",
    "22023": "bad_batch",
};

export async function ingestTelemetry(
    tx: Transaction,
    input: {
        examId: string;
        events: readonly TelemetryEvent[];
        nowMs: number;
    },
): Promise<TelemetryResult> {
    try {
        const rows =
            await tx`select ingest_telemetry(${input.examId}, ${tx.json(input.events.map((e) => ({ kind: e.kind, t: e.t, data: e.data })))}, ${new Date(input.nowMs)}) as n`;
        return { kind: "accepted", events: z.object({ n: z.number() }).parse(rows[0]).n };
    } catch (error) {
        const code =
            typeof error === "object" && error !== null && "code" in error
                ? String(error.code)
                : "";
        const why = TELEMETRY_REFUSALS[code];
        if (why === undefined) throw error;
        return { kind: "refused", why };
    }
}

export const start = (tx: Transaction, examId: string, nowMs: number) =>
    tx`select * from start_exam_session(${examId}, ${new Date(nowMs)})`;

export type SaveResult =
    | { readonly kind: "saved"; readonly ackedSeq: number; readonly deadlineAt: Date }
    | {
          readonly kind: "refused";
          readonly why: "unknown" | "over" | "conflict" | "too_many" | "too_large";
          readonly lastSeq: number | null;
      };

const SAVE_REFUSALS: Readonly<
    Record<string, "unknown" | "over" | "conflict" | "too_many" | "too_large">
> = {
    P0002: "unknown",
    "55000": "over",
    "40001": "conflict",
    "54000": "too_many",
    "22001": "too_large",
};

export async function saveDraft(
    tx: Transaction,
    input: {
        examId: string;
        label: string;
        seq: number;
        language: string;
        content: string;
        nowMs: number;
    },
): Promise<SaveResult> {
    try {
        const rows =
            await tx`select acked_seq, deadline_at from save_exam_draft(${input.examId}, ${input.label},
            ${input.seq}, ${input.language}, ${input.content}, ${new Date(input.nowMs)})`;
        const row = z.object({ acked_seq: z.number().int(), deadline_at: z.date() }).parse(rows[0]);
        return { kind: "saved", ackedSeq: row.acked_seq, deadlineAt: row.deadline_at };
    } catch (error) {
        const code =
            typeof error === "object" && error !== null && "code" in error
                ? String(error.code)
                : "";
        const why = SAVE_REFUSALS[code];
        if (why === undefined) throw error;
        const hint =
            typeof error === "object" && error !== null && "hint" in error
                ? Number(error.hint)
                : null;
        return { kind: "refused", why, lastSeq: Number.isFinite(hint) ? hint : null };
    }
}

const draftSchema = z.object({
    problem_label: z.string(),
    seq: z.number().int(),
    language: z.string(),
    content: z.string(),
});

// The newest saved draft of each problem, for the caller's own session (row-level security) or, for staff, any.
export async function latestDrafts(tx: Transaction, examId: string) {
    const rows =
        await tx`select distinct on (d.problem_label) d.problem_label, d.seq, d.language, d.content
        from exam_drafts d join exam_sessions s on s.id = d.session_id
        where s.exam_id = ${examId} and s.user_id = app_user()
        order by d.problem_label, d.seq desc`;
    return rows.map((row) => draftSchema.parse(row));
}
