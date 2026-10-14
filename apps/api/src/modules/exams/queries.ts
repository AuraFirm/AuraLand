import type { ExamCreateRequest } from "@aura/contracts/exams";
import { examModeSchema, examStateSchema } from "@aura/contracts/exams";
import { EXAM_PROBLEMS_MAX, EXAM_ROSTER_MAX } from "@aura/contracts/limits";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { RosterPerson } from "./roster-csv.ts";

// SQL for exams, run as `aura_app`. Row-level security decides which exams, problems and sessions a caller
// sees; the functions of migration 0044 decide who may change them.

const rowSchema = z.object({
    id: z.string(),
    org_id: z.string(),
    title: z.string(),
    mode: examModeSchema,
    assurance_level: z.literal(1),
    duration_s: z.number().int(),
    window_start: z.date(),
    window_end: z.date(),
    telemetry_retention_days: z.number().int(),
    state: examStateSchema,
    grades_released_at: z.date().nullable(),
});
export type ExamRow = z.infer<typeof rowSchema>;

const COLUMNS = (
    tx: Transaction,
) => tx`id, org_id, title, mode, assurance_level, duration_s, window_start,
    window_end, telemetry_retention_days, state, grades_released_at`;

export async function insertExam(
    tx: Transaction,
    input: { orgId: string; userId: string; exam: ExamCreateRequest },
): Promise<ExamRow> {
    const { exam } = input;
    const rows =
        await tx`insert into exams (org_id, title, mode, duration_s, window_start, window_end,
            telemetry_retention_days, created_by)
        values (${input.orgId}, ${exam.title}, ${exam.mode}, ${exam.duration_s}, ${new Date(exam.window_start)},
                ${new Date(exam.window_end)}, ${exam.telemetry_retention_days}, ${input.userId})
        returning ${COLUMNS(tx)}`;
    return rowSchema.parse(rows[0]);
}

export async function getExam(tx: Transaction, id: string): Promise<ExamRow | null> {
    const rows = await tx`select ${COLUMNS(tx)} from exams where id = ${id}`;
    return rows[0] === undefined ? null : rowSchema.parse(rows[0]);
}

// Newest first by id; for a staff list of one organization, or a candidate's own (what the policy shows).
export async function listExams(
    tx: Transaction,
    input: { orgId: string | null; cursor: string | null; limit: number },
): Promise<{ rows: ExamRow[]; hasMore: boolean }> {
    const rows = await tx`select ${COLUMNS(tx)} from exams
        where ${input.orgId === null ? tx`true` : tx`org_id = ${input.orgId}`}
          and ${input.cursor === null ? tx`true` : tx`id < ${input.cursor}`}
        order by id desc limit ${input.limit + 1}`;
    const parsed = rows.map((row) => rowSchema.parse(row));
    return { rows: parsed.slice(0, input.limit), hasMore: parsed.length > input.limit };
}

const problemSchema = z.object({
    label: z.string(),
    points: z.number().int(),
    auto_percent: z.number().int(),
    rubric: z.array(z.object({ id: z.string(), label: z.string(), max_points: z.number().int() })),
});
export type ProblemRow = z.infer<typeof problemSchema>;

export async function problemsOf(tx: Transaction, examId: string): Promise<ProblemRow[]> {
    const rows = await tx`select label, points, auto_percent, rubric from exam_problems
        where exam_id = ${examId} order by label limit ${EXAM_PROBLEMS_MAX}`;
    return rows.map((row) => problemSchema.parse(row));
}

export async function rosterOf(tx: Transaction, examId: string): Promise<RosterPerson[]> {
    const rows = await tx`select email::text as email, name, extra_minutes from exam_roster
        where exam_id = ${examId} order by email limit ${EXAM_ROSTER_MAX}`;
    return rows.map((row) =>
        z
            .object({ email: z.string(), name: z.string(), extra_minutes: z.number().int() })
            .parse(row),
    );
}

export async function rosterSize(tx: Transaction, examId: string): Promise<number> {
    const rows = await tx`select count(*)::int as n from exam_roster where exam_id = ${examId}`;
    return z.object({ n: z.number() }).parse(rows[0]).n;
}

export interface ExamPatch {
    readonly title?: string;
    readonly mode?: string;
    readonly duration_s?: number;
    readonly window_start?: Date;
    readonly window_end?: Date;
    readonly telemetry_retention_days?: number;
}

// Only draft exams are updatable (policy); a row the caller may not update simply is not touched.
export async function updateExam(
    tx: Transaction,
    id: string,
    patch: ExamPatch,
): Promise<ExamRow | null> {
    const changes: Record<string, string | number | Date> = {};
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) changes[key] = value;
    const rows =
        await tx`update exams set ${tx(changes)} where id = ${id} returning ${COLUMNS(tx)}`;
    return rows[0] === undefined ? null : rowSchema.parse(rows[0]);
}

export type RubricItem = {
    readonly id: string;
    readonly label: string;
    readonly max_points: number;
};

export const addProblem = (
    tx: Transaction,
    examId: string,
    problem: {
        label: string;
        version: string;
        points: number;
        autoPercent: number;
        rubric: readonly RubricItem[];
    },
) => tx`select add_exam_problem(${examId}, ${problem.label}, ${problem.version}, ${problem.points},
    ${problem.autoPercent}, ${tx.json([...problem.rubric])})`;
export const removeProblem = (tx: Transaction, examId: string, label: string) =>
    tx`select remove_exam_problem(${examId}, ${label})`;
export const setRoster = (tx: Transaction, examId: string, people: readonly RosterPerson[]) =>
    tx`select set_exam_roster(${examId}, ${tx.json([...people])})`;
export const publish = (tx: Transaction, examId: string, nowMs: number) =>
    tx`select publish_exam(${examId}, ${new Date(nowMs)})`;
export const releaseGrades = (tx: Transaction, examId: string, nowMs: number) =>
    tx`select release_exam_grades(${examId}, ${new Date(nowMs)})`;
