import {
    answerDetailSchema,
    examResultSchema,
    gradeRequestSchema,
    gradingResponseSchema,
} from "@aura/contracts/api/exams";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { CHECK_VIOLATION, postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { gradesCsv } from "./grades-csv.ts";
import * as q from "./grading-queries.ts";
import { scoreAnswer, toPoints } from "./scores.ts";

export interface GradingRouteDeps {
    readonly clock: Clock;
}

const NO_DATA_FOUND = "P0002";
const OBJECT_NOT_IN_STATE = "55000";
const INSUFFICIENT_PRIVILEGE = "42501";

// Grading (Stage 6, slice 5b): the host's staff score rubrics while the exam is closed and export the grades; a
// candidate reads their own released result. The database decides who may (migration 0048); these routes score,
// translate and audit.
export function gradingRoutes(deps: GradingRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/exams/:id/grading", handleGrading);
    routes.get("/exams/:id/answers/:session_id/:label", handleAnswer);
    routes.put("/exams/:id/grades/:session_id/:label", (c) => handleGrade(c, deps));
    routes.get("/exams/:id/result", handleResult);
    routes.get("/exams/:id/grades.csv", handleCsv);
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");
const invalid = (c: Context<AppEnv>) => problemResponse(c, "invalid_request", "Invalid request");

function ids(c: Context<AppEnv>) {
    const actor = c.get("actor");
    const exam = idSchema("exm").safeParse(c.req.param("id"));
    if (actor.kind !== "user")
        return { problem: problemResponse(c, "unauthenticated", "Authentication required") };
    if (!exam.success) return { problem: invalid(c) };
    const sessionText = c.req.param("session_id");
    const session = sessionText === undefined ? null : idSchema("exs").safeParse(sessionText);
    if (session !== null && !session.success) return { problem: invalid(c) };
    const label = c.req.param("label");
    if (label !== undefined && !/^[A-Z][A-Z0-9]{0,2}$/.test(label)) return { problem: invalid(c) };
    return {
        actor,
        examId: decodeId("exm", exam.data),
        sessionId: session?.success ? decodeId("exs", session.data) : "",
        label: label ?? "",
    };
}

function scored(row: q.GradingRow) {
    const s = scoreAnswer({
        points: row.points,
        autoPercent: row.auto_percent,
        rubric: row.rubric,
        judgeScore: row.score,
        rubricScores: row.rubric_scores,
    });
    return {
        auto: toPoints(s.autoMilli),
        rubric: toPoints(s.rubricMilli),
        total: toPoints(s.totalMilli),
        totalMilli: s.totalMilli,
    };
}

// The staff's grading table. Not-found for anyone who is not the host's owner or admin.
async function staffRows(c: Context<AppEnv>, examId: string): Promise<q.GradingRow[] | null> {
    try {
        return await q.gradingRows(c.get("tx"), examId);
    } catch (error) {
        if (postgresErrorCode(error) === NO_DATA_FOUND) return null;
        throw error;
    }
}

async function handleGrading(c: Context<AppEnv>) {
    const parsed = ids(c);
    if ("problem" in parsed) return parsed.problem;
    const rows = await staffRows(c, parsed.examId);
    if (rows === null) return notFound(c);
    return c.json(
        gradingResponseSchema.parse({
            rows: rows.map((row) => {
                const s = scored(row);
                return {
                    session_id: encodeId("exs", row.session_id),
                    email: row.email,
                    name: row.name,
                    session_state: row.session_state,
                    label: row.label,
                    points: row.points,
                    submission_state: row.submission_state,
                    verdict: row.verdict,
                    judge_score: row.score,
                    auto_points: s.auto,
                    rubric_points: s.rubric,
                    total_points: s.total,
                    rubric: row.rubric,
                    rubric_scores: row.rubric_scores,
                    comment: row.comment,
                };
            }),
        }),
    );
}

async function handleAnswer(c: Context<AppEnv>) {
    const parsed = ids(c);
    if ("problem" in parsed) return parsed.problem;
    const tx = c.get("tx");
    if ((await staffRows(c, parsed.examId)) === null) return notFound(c);
    const detail = await q.answerDetail(tx, parsed);
    return c.json(
        answerDetailSchema.parse({
            language: detail.draft?.language ?? null,
            source: detail.draft?.content ?? null,
            tests: detail.tests,
        }),
    );
}

async function handleGrade(c: Context<AppEnv>, deps: GradingRouteDeps) {
    const parsed = ids(c);
    if ("problem" in parsed) return parsed.problem;
    const body = gradeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const tx = c.get("tx");
    try {
        await q.grade(tx, {
            examId: parsed.examId,
            sessionId: parsed.sessionId,
            label: parsed.label,
            scores: body.data.rubric_scores,
            comment: body.data.comment,
            nowMs: deps.clock.nowUnixMs(),
        });
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND) return notFound(c);
        if (code === CHECK_VIOLATION) return invalid(c);
        if (code === OBJECT_NOT_IN_STATE || code === INSUFFICIENT_PRIVILEGE) {
            return problemResponse(
                c,
                "conflict",
                "Grades can be changed only while the exam is closed",
            );
        }
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: parsed.actor.userId,
        orgId: null,
        action: "exam.graded",
        target: encodeId("exm", parsed.examId),
        detail: { label: parsed.label },
    });
    return c.body(null, 204);
}

// A candidate's own result, only after the grades are released.
async function handleResult(c: Context<AppEnv>) {
    const parsed = ids(c);
    if ("problem" in parsed) return parsed.problem;
    const rows = await q.ownResult(c.get("tx"), parsed.examId);
    const exam = await c.get("tx")`select state from exams where id = ${parsed.examId}`;
    if (rows.length === 0 || exam[0]?.["state"] !== "released") return notFound(c);
    const problems = rows.map((row) => {
        const s = scoreAnswer({
            points: row.points,
            autoPercent: row.auto_percent,
            rubric: row.rubric,
            judgeScore: row.score,
            rubricScores: row.rubric_scores,
        });
        return {
            label: row.label,
            points: row.points,
            auto_points: toPoints(s.autoMilli),
            rubric: row.rubric.map((item) => ({
                ...item,
                awarded: Math.round(row.rubric_scores[item.id] ?? 0),
            })),
            comment: row.comment,
            total_points: toPoints(s.totalMilli),
        };
    });
    return c.json(
        examResultSchema.parse({
            exam_id: encodeId("exm", parsed.examId),
            total_points: problems.reduce((sum, p) => sum + p.total_points, 0),
            max_points: problems.reduce((sum, p) => sum + p.points, 0),
            problems,
        }),
    );
}

async function handleCsv(c: Context<AppEnv>) {
    const parsed = ids(c);
    if ("problem" in parsed) return parsed.problem;
    const rows = await staffRows(c, parsed.examId);
    if (rows === null) return notFound(c);
    const labels = [...new Set(rows.map((row) => row.label))].sort();
    const bySession = new Map<
        string,
        {
            email: string;
            name: string;
            sessionState: string;
            problems: { label: string; totalMilli: number }[];
        }
    >();
    for (const row of rows) {
        const entry = bySession.get(row.session_id) ?? {
            email: row.email,
            name: row.name,
            sessionState: row.session_state,
            problems: [],
        };
        entry.problems.push({ label: row.label, totalMilli: scored(row).totalMilli });
        bySession.set(row.session_id, entry);
    }
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="grades.csv"');
    return c.body(gradesCsv(labels, [...bySession.values()]));
}
