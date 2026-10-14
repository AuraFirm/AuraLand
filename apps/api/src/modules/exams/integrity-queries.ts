import { EXAM_ROSTER_MAX } from "@aura/contracts/limits";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { RaisedFlag } from "./integrity-rules.ts";

// SQL for integrity flags, run as `aura_app`. Who may do what is decided inside the functions of migration 0051.

export async function raise(
    tx: Transaction,
    examId: string,
    flag: RaisedFlag,
    nowMs: number,
    ruleVersion: number,
) {
    const [row] =
        await tx`select raise_integrity_flag(${examId}, ${flag.sessionId}, ${flag.label}, ${flag.kind},
        ${tx.json(flag.evidence)}, ${flag.explanation}, ${ruleVersion}, ${new Date(nowMs)}) as raised`;
    return z.object({ raised: z.boolean() }).parse(row).raised;
}

const counts = z.object({ session_id: z.string(), n: z.coerce.number() });
// Per sitting: the largest paste recorded (characters), for the paste rule.
export async function largestPastes(tx: Transaction, examId: string) {
    const rows = await tx`select t.session_id, max((t.data ->> 'chars')::int) as n
        from telemetry_events t join exam_sessions s on s.id = t.session_id
        where s.exam_id = ${examId} and t.kind = 'paste' and t.data ? 'chars'
        group by t.session_id order by t.session_id limit ${EXAM_ROSTER_MAX}`;
    return rows.map((row) => counts.parse(row));
}

const flagRow = z.object({
    flag_id: z.string(),
    session_id: z.string(),
    label: z.string(),
    kind: z.string(),
    rule_version: z.number().int(),
    evidence: z.record(z.string(), z.unknown()),
    explanation: z.string(),
    state: z.string(),
    decided_at: z.date().nullable(),
    decision_note: z.string(),
    appeal_id: z.string().nullable(),
    appeal_note: z.string().nullable(),
    appeal_state: z.string().nullable(),
    review_note: z.string().nullable(),
});
export type FlagRow = z.infer<typeof flagRow>;

export async function flagsOf(tx: Transaction, examId: string): Promise<FlagRow[]> {
    const rows =
        await tx`select f.id as flag_id, f.session_id, f.problem_label as label, f.kind, f.rule_version,
            f.evidence, f.explanation, f.state, f.decided_at, f.decision_note,
            a.id as appeal_id, a.note as appeal_note, a.state as appeal_state, a.review_note
        from integrity_flags f left join integrity_appeals a on a.flag_id = f.id
        where f.exam_id = ${examId} order by f.id limit 5000`;
    return rows.map((row) => flagRow.parse(row));
}

export const decide = (
    tx: Transaction,
    input: { flag: string; state: string; note: string; nowMs: number },
) =>
    tx`select decide_integrity_flag(${input.flag}, ${input.state}, ${input.note}, ${new Date(input.nowMs)})`;
export const appeal = (tx: Transaction, input: { flag: string; note: string; nowMs: number }) =>
    tx`select appeal_integrity_flag(${input.flag}, ${input.note}, ${new Date(input.nowMs)})`;
export const review = (
    tx: Transaction,
    input: { appeal: string; outcome: string; note: string; nowMs: number },
) =>
    tx`select review_integrity_appeal(${input.appeal}, ${input.outcome}, ${input.note}, ${new Date(input.nowMs)})`;

const mine = z.object({
    flag_id: z.string(),
    problem_label: z.string(),
    kind: z.string(),
    explanation: z.string(),
    rule_version: z.number().int(),
    decided_at: z.date().nullable(),
    appeal_state: z.string().nullable(),
});
export async function ownFlags(tx: Transaction, examId: string) {
    const rows = await tx`select * from my_integrity_flags(${examId})`;
    return rows.map((row) => mine.parse(row));
}

export async function answerLabels(tx: Transaction, examId: string): Promise<string[]> {
    const rows = await tx`select distinct ea.problem_label as label
        from exam_answers ea join exam_sessions s on s.id = ea.session_id
        where s.exam_id = ${examId} order by 1 limit 100`;
    return rows.map((row) => z.object({ label: z.string() }).parse(row).label);
}

export async function sat(tx: Transaction, examId: string): Promise<boolean> {
    const rows =
        await tx`select 1 as one from exam_sessions where exam_id = ${examId} and user_id = app_user() limit 1`;
    return rows.length > 0;
}
