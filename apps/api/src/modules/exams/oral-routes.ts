import {
    oralAnswerRequestSchema,
    oralMineSchema,
    oralRequestedSchema,
    oralScoreRequestSchema,
    oralStaffListSchema,
} from "@aura/contracts/api/exams";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { CHECK_VIOLATION, postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { PROMPT_VERSION } from "./oral-prompt.ts";
import * as q from "./oral-queries.ts";
import * as replay from "./replay-queries.ts";

export interface OralRouteDeps {
    readonly clock: Clock;
}

const NO_DATA_FOUND = "P0002";
const OBJECT_NOT_IN_STATE = "55000";

// Oral defence (Stage 6, slice 10). Staff choose an answer to ask about; a worker has a model write the questions
// (oral-tick.ts); the candidate answers in writing; staff score. The routes translate and audit; the functions of
// migration 0052 decide who may. No route takes a score from anywhere but a person's request.
export function oralRoutes(deps: OralRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/exams/:id/oral/:session_id/:label", (c) => handleRequest(c, deps));
    routes.get("/exams/:id/oral", handleStaffList);
    routes.get("/exams/:id/oral/mine", handleMine);
    routes.put("/exams/:id/oral/:oral_id/answers", (c) => handleAnswer(c, deps));
    routes.put("/exams/:id/oral/:oral_id/score", (c) => handleScore(c, deps));
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");
const invalid = (c: Context<AppEnv>) => problemResponse(c, "invalid_request", "Invalid request");

function who(c: Context<AppEnv>) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return { problem: problemResponse(c, "unauthenticated", "Authentication required") };
    const exam = idSchema("exm").safeParse(c.req.param("id"));
    if (!exam.success) return { problem: invalid(c) };
    return { actor, examId: decodeId("exm", exam.data) };
}

function translated(c: Context<AppEnv>, error: unknown) {
    const code = postgresErrorCode(error);
    if (code === NO_DATA_FOUND) return notFound(c);
    if (code === CHECK_VIOLATION) return invalid(c);
    if (code === OBJECT_NOT_IN_STATE)
        return problemResponse(c, "conflict", "Conflict", "not in the right state for this");
    throw error;
}

async function handleRequest(c: Context<AppEnv>, deps: OralRouteDeps) {
    const parsed = who(c);
    if ("problem" in parsed) return parsed.problem;
    const session = idSchema("exs").safeParse(c.req.param("session_id"));
    const label = c.req.param("label") ?? "";
    if (!session.success || !/^[A-Z][A-Z0-9]{0,2}$/.test(label)) return invalid(c);
    const tx = c.get("tx");
    try {
        const id = await q.request(tx, {
            exam: parsed.examId,
            session: decodeId("exs", session.data),
            label,
            version: PROMPT_VERSION,
            nowMs: deps.clock.nowUnixMs(),
        });
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: parsed.actor.userId,
            orgId: null,
            action: "exam.oral_requested",
            target: encodeId("ora", id),
            detail: { label },
        });
        return c.json(oralRequestedSchema.parse({ oral_id: encodeId("ora", id) }), 202);
    } catch (error) {
        return translated(c, error);
    }
}

async function handleStaffList(c: Context<AppEnv>) {
    const parsed = who(c);
    if ("problem" in parsed) return parsed.problem;
    const tx = c.get("tx");
    try {
        const people = await replay.monitorRows(tx, parsed.examId);
        const rows = await q.staffRows(tx, parsed.examId);
        return c.json(
            oralStaffListSchema.parse({
                rows: rows.map((r) => {
                    const person = people.find((p) => p.session_id === r.session_id);
                    return {
                        oral_id: encodeId("ora", r.id),
                        session_id: encodeId("exs", r.session_id),
                        name: person?.name ?? "",
                        email: person?.email ?? "",
                        label: r.label,
                        state: r.state,
                        questions: r.questions,
                        answers: r.answers,
                        failure: r.failure,
                        score: r.score,
                        score_note: r.score_note,
                    };
                }),
            }),
        );
    } catch (error) {
        return translated(c, error);
    }
}

async function handleMine(c: Context<AppEnv>) {
    const parsed = who(c);
    if ("problem" in parsed) return parsed.problem;
    const tx = c.get("tx");
    const sat =
        await tx`select 1 as one from exam_sessions where exam_id = ${parsed.examId} and user_id = app_user() limit 1`;
    if (sat.length === 0) return notFound(c);
    const rows = await q.mine(tx, parsed.examId);
    return c.json(
        oralMineSchema.parse({
            rows: rows.map((r) => ({
                oral_id: encodeId("ora", r.id),
                label: r.problem_label,
                state: r.state,
                questions: r.questions,
                answers: r.answers,
            })),
        }),
    );
}

async function handleAnswer(c: Context<AppEnv>, deps: OralRouteDeps) {
    const parsed = who(c);
    if ("problem" in parsed) return parsed.problem;
    const oral = idSchema("ora").safeParse(c.req.param("oral_id"));
    const body = oralAnswerRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!oral.success || !body.success) return invalid(c);
    try {
        await q.answer(c.get("tx"), {
            id: decodeId("ora", oral.data),
            answers: body.data.answers,
            nowMs: deps.clock.nowUnixMs(),
        });
    } catch (error) {
        return translated(c, error);
    }
    return c.body(null, 204);
}

async function handleScore(c: Context<AppEnv>, deps: OralRouteDeps) {
    const parsed = who(c);
    if ("problem" in parsed) return parsed.problem;
    const oral = idSchema("ora").safeParse(c.req.param("oral_id"));
    const body = oralScoreRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!oral.success || !body.success) return invalid(c);
    const tx = c.get("tx");
    try {
        await q.score(tx, {
            id: decodeId("ora", oral.data),
            score: body.data.score,
            note: body.data.note,
            nowMs: deps.clock.nowUnixMs(),
        });
    } catch (error) {
        return translated(c, error);
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: parsed.actor.userId,
        orgId: null,
        action: "exam.oral_scored",
        target: oral.data,
        detail: { score: body.data.score },
    });
    return c.body(null, 204);
}
