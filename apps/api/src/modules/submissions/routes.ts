import {
    submissionCreateRequestSchema,
    submissionListQuerySchema,
    submissionSchema,
    submissionsResponseSchema,
} from "@aura/contracts/api/submissions";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { SUBMISSIONS_PER_MINUTE_PER_TASK_MAX } from "@aura/contracts/limits";
import { appendAudit } from "@aura/db/audit";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { RateLimitRule } from "../../platform/rate-limit.ts";
import {
    consumeRateLimit,
    type RateLimitDeps,
    refuseRateLimited,
} from "../../rate-limit-middleware.ts";
import {
    enqueueForJudging,
    getSubmission,
    insertSubmission,
    listMine,
    type SubmissionRow,
    testResults,
    versionForSubmission,
} from "./queries.ts";

export type SubmissionRouteDeps = Pick<RateLimitDeps, "sql" | "clock" | "key">;

const SUBMIT_BY_TASK: RateLimitRule = {
    name: "submit:user-task",
    max: SUBMISSIONS_PER_MINUTE_PER_TASK_MAX,
    windowS: 60,
};

export function submissionRoutes(deps: SubmissionRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/task-versions/:id/submissions", (c) => handleCreate(c, deps));
    routes.get("/submissions", handleList);
    routes.get("/submissions/:id", handleGet);
    return routes;
}

function caller(c: Context<AppEnv>) {
    const actor = c.get("actor");
    return actor.kind === "user" ? { userId: actor.userId, orgs: actor.orgs } : null;
}

const unauthenticated = (c: Context<AppEnv>) =>
    problemResponse(c, "unauthenticated", "Authentication required");
const invalid = (c: Context<AppEnv>, detail?: string) =>
    problemResponse(c, "invalid_request", "Invalid request", detail);
const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");

function submissionBody(
    row: SubmissionRow,
    results: Awaited<ReturnType<typeof testResults>> | null,
) {
    return submissionSchema.parse({
        id: encodeId("sub", row.id),
        task_version_id: encodeId("tsv", row.task_version_id),
        language: row.language,
        state: row.state,
        verdict: row.verdict,
        score: row.score,
        created_at: row.created_at.toISOString(),
        judged_at: row.judged_at?.toISOString() ?? null,
        source: results === null ? null : row.source,
        tests: results,
    });
}

async function handleCreate(c: Context<AppEnv>, deps: SubmissionRouteDeps) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const parsedId = idSchema("tsv").safeParse(c.req.param("id"));
    const body = submissionCreateRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsedId.success || !body.success) return invalid(c);
    const tx = c.get("tx");
    const version = await versionForSubmission(tx, decodeId("tsv", parsedId.data));
    // Someone who cannot see the version, or does not belong to its organization, learns nothing.
    if (version === null || !who.orgs.some((m) => m.orgId === version.org_id)) return notFound(c);
    if (version.state !== "released" || version.spec === null) {
        return problemResponse(c, "conflict", "Only a released version accepts submissions");
    }
    if (!version.spec.languages.includes(body.data.language)) {
        return invalid(c, "this task does not accept that language");
    }
    const verdict = await consumeRateLimit(
        deps,
        SUBMIT_BY_TASK,
        `${who.userId}:${version.task_id}`,
    );
    if (!verdict.allowed) return refuseRateLimited(c, verdict);
    const nowMs = deps.clock.nowUnixMs();
    const id = await insertSubmission(tx, {
        orgId: version.org_id,
        userId: who.userId,
        versionId: version.id,
        language: body.data.language,
        source: body.data.source,
        nowMs,
    });
    if (!(await enqueueForJudging(tx, id, nowMs))) {
        // Throwing rolls the transaction back, so no submission is left waiting for nothing; the
        // error handler turns this into a 503 with a retry hint.
        throw new QueueFullError();
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: who.userId,
        orgId: version.org_id,
        action: "submission.created",
        target: encodeId("sub", id),
        detail: { language: body.data.language, bytes: Buffer.byteLength(body.data.source) },
    });
    const row = await getSubmission(tx, id);
    if (row === null) throw new Error("a new submission is visible to its owner");
    return c.json(submissionBody(row, null), 201);
}

// How long a person is told to wait when the judge queue is full.
export const QUEUE_FULL_RETRY_AFTER_S = 30;

export class QueueFullError extends Error {
    constructor() {
        super("the judge queue is full");
        this.name = "QueueFullError";
    }
}

async function handleGet(c: Context<AppEnv>) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const parsed = idSchema("sub").safeParse(c.req.param("id"));
    if (!parsed.success) return invalid(c);
    const tx = c.get("tx");
    const row = await getSubmission(tx, decodeId("sub", parsed.data));
    if (row === null) return notFound(c);
    return c.json(submissionBody(row, await testResults(tx, row.id)));
}

async function handleList(c: Context<AppEnv>) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const query = submissionListQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalid(c);
    const cursor = query.data.cursor === undefined ? null : decodeId("sub", query.data.cursor);
    const page = await listMine(
        c.get("tx"),
        who.userId,
        decodeId("tsv", query.data.task_version_id),
        cursor,
        query.data.limit,
    );
    const last = page.rows[page.rows.length - 1];
    return c.json(
        submissionsResponseSchema.parse({
            items: page.rows.map((row) => submissionBody(row, null)),
            next_cursor: page.hasMore && last !== undefined ? encodeId("sub", last.id) : null,
        }),
    );
}
