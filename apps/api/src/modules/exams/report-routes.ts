import { examSummarySchema } from "@aura/contracts/api/exams";
import { decodeId, idSchema } from "@aura/contracts/ids";
import { postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { attainmentCsv } from "./attainment-report.ts";
import * as grading from "./grading-queries.ts";
import * as integrity from "./integrity-queries.ts";
import * as oral from "./oral-queries.ts";
import * as replay from "./replay-queries.ts";
import { scoreAnswer } from "./scores.ts";

const NO_DATA_FOUND = "P0002";

// For the institution (Stage 6, slice 11): a summary of one exam's state of play, and the draft attainment report.
// Staff of the host only; anyone else gets the same not-found as for an exam that does not exist.
export function reportRoutes(): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/exams/:id/summary", handleSummary);
    routes.get("/exams/:id/report.csv", handleReport);
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");

// Wraps a staff-only read: the database says no with P0002, which is a not-found here.
async function forStaff<T>(c: Context<AppEnv>, read: (examId: string) => Promise<T>) {
    if (c.get("actor").kind !== "user")
        return { problem: problemResponse(c, "unauthenticated", "Authentication required") };
    const id = idSchema("exm").safeParse(c.req.param("id"));
    if (!id.success) return { problem: problemResponse(c, "invalid_request", "Invalid request") };
    try {
        return { value: await read(decodeId("exm", id.data)) };
    } catch (error) {
        if (postgresErrorCode(error) === NO_DATA_FOUND) return { problem: notFound(c) };
        throw error;
    }
}

async function handleSummary(c: Context<AppEnv>) {
    const tx = c.get("tx");
    const result = await forStaff(c, async (examId) => {
        const people = await replay.monitorRows(tx, examId);
        const flags = await integrity.flagsOf(tx, examId);
        const orals = await oral.staffRows(tx, examId);
        const count = (state: string) => people.filter((p) => p.state === state).length;
        return {
            joined: people.length,
            consented: people.filter((p) => p.consented).length,
            started: count("started"),
            submitted: count("submitted"),
            expired: count("expired"),
            flags_open: flags.filter((f) => f.state === "unreviewed" || f.state === "needs_review")
                .length,
            appeals_open: flags.filter((f) => f.appeal_state === "open").length,
            oral_waiting: orals.filter((o) => o.state === "answered").length,
        };
    });
    if ("problem" in result) return result.problem;
    return c.json(examSummarySchema.parse(result.value));
}

async function handleReport(c: Context<AppEnv>) {
    const tx = c.get("tx");
    const result = await forStaff(c, (examId) => grading.gradingRows(tx, examId));
    if ("problem" in result) return result.problem;
    const csv = attainmentCsv(
        result.value.map((row) => ({
            label: row.label,
            points: row.points,
            sessionId: row.session_id,
            answered: row.submission_state !== null,
            totalMilli: scoreAnswer({
                points: row.points,
                autoPercent: row.auto_percent,
                rubric: row.rubric,
                judgeScore: row.score,
                rubricScores: row.rubric_scores,
            }).totalMilli,
        })),
    );
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="attainment.csv"');
    return c.body(csv);
}
