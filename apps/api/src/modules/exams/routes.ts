import {
    examListQuerySchema,
    examProblemAddRequestSchema,
    examSchema,
    examsResponseSchema,
    examUpdateRequestSchema,
    rosterCountSchema,
    rosterResponseSchema,
    rosterUploadRequestSchema,
} from "@aura/contracts/api/exams";
import { examCreateRequestSchema } from "@aura/contracts/exams";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import type { Transaction } from "@aura/db/context";
import { CHECK_VIOLATION, postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import * as q from "./queries.ts";
import { parseRosterCsv } from "./roster-csv.ts";

export interface ExamRouteDeps {
    readonly clock: Clock;
}

const NO_DATA_FOUND = "P0002";
const INSUFFICIENT_PRIVILEGE = "42501";

// Exams, the instructor's side (Stage 6, slice 2). What a person sees is decided by row-level security (a
// draft is the host staff's, a candidate sees an exam they are on the roster of); who may change one is
// decided by the functions of migration 0044. These routes translate that into responses and keep the
// audit trail. The candidate's own sitting (join, consent, start, save) is slice 3 and later.
export function examRoutes(deps: ExamRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/exams", handleList);
    routes.get("/exams/:id", handleGet);
    routes.post("/orgs/:id/exams", handleCreate);
    routes.patch("/exams/:id", handleUpdate);
    routes.post("/exams/:id/problems", handleAddProblem);
    routes.delete("/exams/:id/problems/:label", handleRemoveProblem);
    routes.put("/exams/:id/roster", handleSetRoster);
    routes.get("/exams/:id/roster", handleGetRoster);
    routes.post("/exams/:id/publish", (c) => transition(c, deps, "publish"));
    routes.post("/exams/:id/release-grades", (c) => transition(c, deps, "release"));
    return routes;
}

const invalid = (c: Context<AppEnv>, detail?: string) =>
    problemResponse(c, "invalid_request", "Invalid request", detail);
const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");
const readJson = (c: Context<AppEnv>): Promise<unknown> =>
    c.req.json().then(
        (body: unknown) => body,
        () => null,
    );

function person(c: Context<AppEnv>) {
    const actor = c.get("actor");
    return actor.kind === "user" ? actor : null;
}

const isManager = (c: Context<AppEnv>, orgId: string): boolean => {
    const role = person(c)?.orgs.find((membership) => membership.orgId === orgId)?.role;
    return role === "owner" || role === "admin";
};

function examIdParam(c: Context<AppEnv>): string | null {
    const parsed = idSchema("exm").safeParse(c.req.param("id"));
    return parsed.success ? decodeId("exm", parsed.data) : null;
}

// The problem list is the staff's, and a candidate's once their own sitting has started (row-level security
// returns nothing before that), so for a candidate with nothing to see it is null, not an empty exam.
async function visibleProblems(tx: Transaction, examId: string, manage: boolean) {
    const problems = await q.problemsOf(tx, examId);
    return manage || problems.length > 0 ? problems : null;
}

// The exam as the caller may see it: problems and the roster size only for the host's staff.
async function body(c: Context<AppEnv>, row: q.ExamRow) {
    const tx = c.get("tx");
    const manage = isManager(c, row.org_id);
    return examSchema.parse({
        id: encodeId("exm", row.id),
        org_id: encodeId("org", row.org_id),
        title: row.title,
        mode: row.mode,
        assurance_level: row.assurance_level,
        duration_s: row.duration_s,
        window_start: row.window_start.toISOString(),
        window_end: row.window_end.toISOString(),
        telemetry_retention_days: row.telemetry_retention_days,
        state: row.state,
        grades_released_at: row.grades_released_at?.toISOString() ?? null,
        problems: await visibleProblems(tx, row.id, manage),
        roster_size: manage ? await q.rosterSize(tx, row.id) : null,
        can_manage: manage,
    });
}

async function handleList(c: Context<AppEnv>) {
    if (person(c) === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const query = examListQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalid(c);
    const page = await q.listExams(c.get("tx"), {
        orgId: query.data.org_id === undefined ? null : decodeId("org", query.data.org_id),
        cursor: query.data.cursor === undefined ? null : decodeId("exm", query.data.cursor),
        limit: query.data.limit,
    });
    const last = page.rows[page.rows.length - 1];
    return c.json(
        examsResponseSchema.parse({
            exams: await Promise.all(page.rows.map((row) => body(c, row))),
            next_cursor: page.hasMore && last !== undefined ? encodeId("exm", last.id) : null,
        }),
    );
}

async function handleGet(c: Context<AppEnv>) {
    if (person(c) === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const id = examIdParam(c);
    if (id === null) return notFound(c);
    const row = await q.getExam(c.get("tx"), id);
    return row === null ? notFound(c) : c.json(await body(c, row));
}

async function handleCreate(c: Context<AppEnv>) {
    const actor = person(c);
    if (actor === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const org = idSchema("org").safeParse(c.req.param("id"));
    const request = examCreateRequestSchema.safeParse(await readJson(c));
    if (!org.success || !request.success) return invalid(c);
    const orgId = decodeId("org", org.data);
    if (!actor.orgs.some((membership) => membership.orgId === orgId)) return notFound(c);
    if (!isManager(c, orgId)) return problemResponse(c, "forbidden", "Forbidden");
    const tx = c.get("tx");
    try {
        const row = await q.insertExam(tx, { orgId, userId: actor.userId, exam: request.data });
        for (const problem of request.data.problems) {
            await q.addProblem(tx, row.id, {
                label: problem.label,
                version: decodeId("tsv", problem.task_version_id),
                points: problem.points,
                autoPercent: problem.auto_percent,
                rubric: problem.rubric,
            });
        }
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: actor.userId,
            orgId,
            action: "exam.created",
            target: encodeId("exm", row.id),
            detail: { mode: row.mode, problems: request.data.problems.length },
        });
        return c.json(await body(c, row), 201);
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === CHECK_VIOLATION) return invalid(c);
        if (code === NO_DATA_FOUND)
            return invalid(c, "a problem is not a released version you can use");
        if (code === INSUFFICIENT_PRIVILEGE) return problemResponse(c, "forbidden", "Forbidden");
        throw error;
    }
}

async function handleUpdate(c: Context<AppEnv>) {
    const actor = person(c);
    if (actor === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const id = examIdParam(c);
    const request = examUpdateRequestSchema.safeParse(await readJson(c));
    if (id === null || !request.success) return invalid(c);
    const tx = c.get("tx");
    const current = await q.getExam(tx, id);
    if (current === null) return notFound(c);
    if (!isManager(c, current.org_id)) return problemResponse(c, "forbidden", "Forbidden");
    try {
        const patch = request.data;
        const row = await q.updateExam(tx, id, {
            ...(patch.title === undefined ? {} : { title: patch.title }),
            ...(patch.mode === undefined ? {} : { mode: patch.mode }),
            ...(patch.duration_s === undefined ? {} : { duration_s: patch.duration_s }),
            ...(patch.window_start === undefined
                ? {}
                : { window_start: new Date(patch.window_start) }),
            ...(patch.window_end === undefined ? {} : { window_end: new Date(patch.window_end) }),
            ...(patch.telemetry_retention_days === undefined
                ? {}
                : { telemetry_retention_days: patch.telemetry_retention_days }),
        });
        if (row === null) return problemResponse(c, "conflict", "Only a draft exam can be changed");
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: actor.userId,
            orgId: row.org_id,
            action: "exam.updated",
            target: encodeId("exm", id),
            detail: { fields: Object.keys(request.data) },
        });
        return c.json(await body(c, row));
    } catch (error) {
        if (postgresErrorCode(error) === CHECK_VIOLATION) return invalid(c);
        throw error;
    }
}

async function handleAddProblem(c: Context<AppEnv>) {
    const actor = person(c);
    if (actor === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const id = examIdParam(c);
    const request = examProblemAddRequestSchema.safeParse(await readJson(c));
    if (id === null || !request.success) return invalid(c);
    const tx = c.get("tx");
    try {
        await q.addProblem(tx, id, {
            label: request.data.label,
            version: decodeId("tsv", request.data.task_version_id),
            points: request.data.points,
            autoPercent: request.data.auto_percent,
            rubric: request.data.rubric,
        });
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND) return notFound(c);
        if (code === CHECK_VIOLATION) return invalid(c, "that problem cannot be added");
        if (code === INSUFFICIENT_PRIVILEGE || code === "23505")
            return problemResponse(c, "conflict", "That problem cannot be added");
        throw error;
    }
    const row = await q.getExam(tx, id);
    if (row === null) return notFound(c);
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: row.org_id,
        action: "exam.problem_added",
        target: encodeId("exm", id),
        detail: { label: request.data.label },
    });
    return c.json(await body(c, row), 201);
}

async function handleRemoveProblem(c: Context<AppEnv>) {
    const actor = person(c);
    if (actor === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const id = examIdParam(c);
    const label = c.req.param("label") ?? "";
    if (id === null || !/^[A-Z][A-Z0-9]{0,2}$/.test(label)) return invalid(c);
    const tx = c.get("tx");
    const before = await q.getExam(tx, id);
    try {
        await q.removeProblem(tx, id, label);
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND) return notFound(c);
        if (code === INSUFFICIENT_PRIVILEGE)
            return problemResponse(c, "conflict", "Only a draft exam can be changed");
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: before?.org_id ?? null,
        action: "exam.problem_removed",
        target: encodeId("exm", id),
        detail: { label },
    });
    return c.body(null, 204);
}

// The roster is replaced as a whole from CSV text. Whole-file validation first: a bad line writes nothing.
async function handleSetRoster(c: Context<AppEnv>) {
    const actor = person(c);
    if (actor === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const id = examIdParam(c);
    const request = rosterUploadRequestSchema.safeParse(await readJson(c));
    if (id === null || !request.success) return invalid(c);
    const parsed = parseRosterCsv(request.data.csv);
    if (!parsed.ok) return invalid(c, parsed.problems.join("; "));
    const tx = c.get("tx");
    const exam = await q.getExam(tx, id);
    if (exam === null) return notFound(c);
    if (!isManager(c, exam.org_id)) return problemResponse(c, "forbidden", "Forbidden");
    try {
        await q.setRoster(tx, id, parsed.people);
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND)
            return problemResponse(c, "conflict", "The roster can be changed until the exam opens");
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: exam.org_id,
        action: "exam.roster_set",
        target: encodeId("exm", id),
        detail: { people: parsed.people.length },
    });
    return c.json(rosterCountSchema.parse({ people: parsed.people.length }));
}

async function handleGetRoster(c: Context<AppEnv>) {
    if (person(c) === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const id = examIdParam(c);
    if (id === null) return notFound(c);
    const tx = c.get("tx");
    const exam = await q.getExam(tx, id);
    if (exam === null || !isManager(c, exam.org_id)) return notFound(c);
    return c.json(rosterResponseSchema.parse({ people: await q.rosterOf(tx, id) }));
}

async function transition(c: Context<AppEnv>, deps: ExamRouteDeps, kind: "publish" | "release") {
    const actor = person(c);
    if (actor === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const id = examIdParam(c);
    if (id === null) return notFound(c);
    const tx = c.get("tx");
    const before = await q.getExam(tx, id);
    if (before === null) return notFound(c);
    if (!isManager(c, before.org_id)) return problemResponse(c, "forbidden", "Forbidden");
    try {
        if (kind === "publish") await q.publish(tx, id, deps.clock.nowUnixMs());
        else await q.releaseGrades(tx, id, deps.clock.nowUnixMs());
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND)
            return problemResponse(c, "conflict", "This exam is not in the right state");
        if (code === "55000")
            return problemResponse(c, "conflict", "Answers are still being collected or judged");
        if (code === CHECK_VIOLATION)
            return problemResponse(
                c,
                "conflict",
                "An exam is published before its window opens, with a problem and a person",
            );
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: before.org_id,
        action: kind === "publish" ? "exam.published" : "exam.grades_released",
        target: encodeId("exm", id),
    });
    const row = await q.getExam(tx, id);
    return row === null ? notFound(c) : c.json(await body(c, row));
}
