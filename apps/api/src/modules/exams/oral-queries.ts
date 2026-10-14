import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for oral defence, run as `aura_app`. The functions of migration 0052 decide who may do what.

export async function request(
    tx: Transaction,
    input: { exam: string; session: string; label: string; version: number; nowMs: number },
) {
    const [row] =
        await tx`select request_oral_defence(${input.exam}, ${input.session}, ${input.label},
        ${input.version}, ${new Date(input.nowMs)}) as id`;
    return z.object({ id: z.string() }).parse(row).id;
}

const strings = z.array(z.string()).nullable();
const staffRow = z.object({
    id: z.string(),
    session_id: z.string(),
    label: z.string(),
    state: z.string(),
    questions: strings,
    answers: strings,
    failure: z.string(),
    score: z.number().int().nullable(),
    score_note: z.string(),
});
export type StaffRow = z.infer<typeof staffRow>;

export async function staffRows(tx: Transaction, examId: string): Promise<StaffRow[]> {
    const rows =
        await tx`select id, session_id, problem_label as label, state, questions, answers, failure, score, score_note
        from oral_defences where exam_id = ${examId} order by id limit 5000`;
    return rows.map((row) => staffRow.parse(row));
}

const mineRow = z.object({
    id: z.string(),
    problem_label: z.string(),
    state: z.string(),
    questions: strings,
    answers: strings,
});
export async function mine(tx: Transaction, examId: string) {
    const rows = await tx`select * from my_oral_defences(${examId})`;
    return rows.map((row) => mineRow.parse(row));
}

export const answer = (tx: Transaction, input: { id: string; answers: string[]; nowMs: number }) =>
    tx`select answer_oral_defence(${input.id}, ${tx.json(input.answers)}, ${new Date(input.nowMs)})`;
export const score = (
    tx: Transaction,
    input: { id: string; score: number; note: string; nowMs: number },
) =>
    tx`select score_oral_defence(${input.id}, ${input.score}, ${input.note}, ${new Date(input.nowMs)})`;
