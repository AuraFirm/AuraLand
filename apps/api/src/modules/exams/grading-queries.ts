import { EXAM_ROSTER_MAX } from "@aura/contracts/limits";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for grading, run as `aura_app`. The functions of migration 0048 check that the caller is the host's owner or
// admin; the policies keep a candidate to their own released results.

const rubricSchema = z.array(
    z.object({ id: z.string(), label: z.string(), max_points: z.number().int() }),
);
const rowSchema = z.object({
    session_id: z.string(),
    email: z.string(),
    name: z.string(),
    session_state: z.string(),
    label: z.string(),
    points: z.number().int(),
    auto_percent: z.number().int(),
    rubric: rubricSchema,
    submission_id: z.string().nullable(),
    submission_state: z.string().nullable(),
    verdict: z.string().nullable(),
    score: z.coerce.number().nullable(),
    rubric_scores: z.record(z.string(), z.number()),
    comment: z.string(),
});
export type GradingRow = z.infer<typeof rowSchema>;

export async function gradingRows(tx: Transaction, examId: string): Promise<GradingRow[]> {
    const rows = await tx`select * from exam_grading_rows(${examId}) limit ${EXAM_ROSTER_MAX * 12}`;
    return rows.map((row) => rowSchema.parse(row));
}

export const grade = (
    tx: Transaction,
    input: {
        examId: string;
        sessionId: string;
        label: string;
        scores: Record<string, number>;
        comment: string;
        nowMs: number;
    },
) => tx`select grade_exam_answer(${input.examId}, ${input.sessionId}, ${input.label}, ${tx.json(input.scores)},
    ${input.comment}, ${new Date(input.nowMs)})`;

export async function answerDetail(
    tx: Transaction,
    input: { examId: string; sessionId: string; label: string },
) {
    const drafts =
        await tx`select language, content from exam_drafts d join exam_sessions s on s.id = d.session_id
        where s.exam_id = ${input.examId} and d.session_id = ${input.sessionId} and d.problem_label = ${input.label}
        order by d.seq desc limit 1`;
    const tests =
        await tx`select v.test_id, v.verdict from exam_answers a join verdict_details v on v.submission_id = a.submission_id
        where a.session_id = ${input.sessionId} and a.problem_label = ${input.label} order by v.test_id limit 500`;
    const draft =
        drafts[0] === undefined
            ? null
            : z.object({ language: z.string(), content: z.string() }).parse(drafts[0]);
    return {
        draft,
        tests: tests.map((t) => z.object({ test_id: z.string(), verdict: z.string() }).parse(t)),
    };
}

// A candidate's own results, after release: the same rows, narrowed by the policies to their sitting. Because
// exam_grading_rows is staff only, this reads the tables directly.
export async function ownResult(tx: Transaction, examId: string) {
    const rows = await tx`select p.label, p.points, p.auto_percent, p.rubric, sub.score,
            coalesce(g.rubric_scores, '{}'::jsonb) as rubric_scores, coalesce(g.comment, '') as comment
        from exam_sessions s join exam_problems p on p.exam_id = s.exam_id
        left join exam_answers a on a.session_id = s.id and a.problem_label = p.label
        left join submissions sub on sub.id = a.submission_id
        left join exam_grades g on g.session_id = s.id and g.problem_label = p.label
        where s.exam_id = ${examId} and s.user_id = app_user() order by p.label`;
    return rows.map((row) =>
        z
            .object({
                label: z.string(),
                points: z.number().int(),
                auto_percent: z.number().int(),
                rubric: rubricSchema,
                score: z.coerce.number().nullable(),
                rubric_scores: z.record(z.string(), z.number()),
                comment: z.string(),
            })
            .parse(row),
    );
}
