import {
    practiceDailySchema,
    practiceListQuerySchema,
    practiceListRequestSchema,
    practiceListSchema,
    practiceProblemSchema,
} from "@aura/contracts/api/practice";
import { submissionCreateRequestSchema } from "@aura/contracts/api/submissions";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { judgeLanguageSchema } from "@aura/contracts/judging";
import { JUDGE_QUEUE_READY_MAX, SUBMISSIONS_PER_MINUTE_PER_TASK_MAX } from "@aura/contracts/limits";
import { appendAudit } from "@aura/db/audit";
import type { Transaction } from "@aura/db/context";
import { postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import { renderMarkdownSafe } from "../../platform/markdown.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { RateLimitRule } from "../../platform/rate-limit.ts";
import { hasFreshStepUp } from "../../platform/step-up.ts";
import { consumeRateLimit, refuseRateLimited } from "../../rate-limit-middleware.ts";
import { getSubmission } from "./queries.ts";
import { type SubmissionRouteDeps, submissionBody } from "./routes.ts";

const PRACTICE_BY_USER: RateLimitRule = {
    name: "practice-submit:user-problem",
    max: SUBMISSIONS_PER_MINUTE_PER_TASK_MAX,
    windowS: 60,
};

// The practice bank: anyone reads the list, the daily pick and a problem's statement; a signed-in person
// submits; a platform administrator curates. Every read and write goes through the functions of migration
// 0042, so the staff routes for tasks stay closed to people outside the task's organization.
export function practiceRoutes(deps: SubmissionRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/practice", handleList);
    routes.get("/practice/daily", (c) => handleDaily(c, deps));
    routes.get("/practice/:id", handleProblem);
    routes.post("/practice/:id/submissions", (c) => handleSubmit(c, deps));
    routes.post("/admin/practice", (c) => handleCurate(c, deps, "list"));
    routes.delete("/admin/practice/:id", (c) => handleCurate(c, deps, "unlist"));
    return routes;
}

const invalid = (c: Context<AppEnv>) => problemResponse(c, "invalid_request", "Invalid request");
const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");
const itemSchema = z.object({ version_id: z.string(), title: z.string() });

const item = (row: z.infer<typeof itemSchema>) => ({
    id: encodeId("tsv", row.version_id),
    title: row.title,
});

async function handleList(c: Context<AppEnv>) {
    const query = practiceListQuerySchema.safeParse(c.req.query());
    if (!query.success) return invalid(c);
    const tx = c.get("tx");
    const cursor = query.data.cursor === undefined ? null : decodeId("tsv", query.data.cursor);
    // Newest listing first; (listed_at, version id) is unique, so the order is total and the cursor exact.
    const rows = await tx`select version_id, title from practice_bank
        where ${cursor === null ? tx`true` : tx`(listed_at, version_id) < (select listed_at, version_id from practice_bank where version_id = ${cursor})`}
        order by listed_at desc, version_id desc limit ${query.data.limit + 1}`;
    const parsed = rows.map((row) => itemSchema.parse(row));
    const page = parsed.slice(0, query.data.limit);
    const last = page[page.length - 1];
    return c.json(
        practiceListSchema.parse({
            items: page.map(item),
            next_cursor:
                parsed.length > query.data.limit && last !== undefined
                    ? encodeId("tsv", last.version_id)
                    : null,
        }),
    );
}

async function handleDaily(c: Context<AppEnv>, deps: SubmissionRouteDeps) {
    // The day is the server's, in UTC: one pick for the whole world, however the browser's clock is set.
    const day = new Date(deps.clock.nowUnixMs()).toISOString().slice(0, 10);
    const tx = c.get("tx");
    const picked = await tx`select practice_daily(${day}::date) as id`;
    const id = z.object({ id: z.string().nullable() }).parse(picked[0]).id;
    if (id === null) return c.json(practiceDailySchema.parse({ day, problem: null }));
    const rows = await tx`select version_id, title from practice_bank where version_id = ${id}`;
    const row = rows[0] === undefined ? null : itemSchema.parse(rows[0]);
    return c.json(practiceDailySchema.parse({ day, problem: row === null ? null : item(row) }));
}

const problemRowSchema = z.object({
    title: z.string(),
    statement: z.string(),
    time_limit_ms: z.number(),
    memory_limit_kib: z.number(),
    languages: z.array(z.string()),
});

async function handleProblem(c: Context<AppEnv>) {
    const id = idSchema("tsv").safeParse(c.req.param("id"));
    if (!id.success) return invalid(c);
    const rows = await c.get("tx")`select * from practice_problem(${decodeId("tsv", id.data)})`;
    if (rows[0] === undefined) return notFound(c);
    const row = problemRowSchema.parse(rows[0]);
    return c.json(
        practiceProblemSchema.parse({
            id: id.data,
            title: row.title,
            time_limit_ms: row.time_limit_ms,
            memory_limit_kib: row.memory_limit_kib,
            // Only the languages our judges run; a task may name more.
            languages: row.languages.filter((l) => judgeLanguageSchema.safeParse(l).success),
            statement_html: renderMarkdownSafe(row.statement).html,
        }),
    );
}

async function createPractice(
    tx: Transaction,
    input: { versionId: string; language: string; source: string; nowMs: number },
): Promise<
    { id: string } | { refused: "unknown" | "language" | "too_large" | "queue_full" | "contest" }
> {
    try {
        const rows =
            await tx`select create_practice_submission(${input.versionId}, ${input.language},
            ${input.source}, ${new Date(input.nowMs)}, ${JUDGE_QUEUE_READY_MAX}) as id`;
        return { id: z.object({ id: z.string() }).parse(rows[0]).id };
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === "P0002") return { refused: "unknown" };
        if (code === "22023") return { refused: "language" };
        if (code === "22001") return { refused: "too_large" };
        if (code === "53400") return { refused: "queue_full" };
        // The guard on submissions: the problem is in a contest that has not ended.
        if (code === "23514") return { refused: "contest" };
        throw error;
    }
}

async function handleSubmit(c: Context<AppEnv>, deps: SubmissionRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const id = idSchema("tsv").safeParse(c.req.param("id"));
    const body = submissionCreateRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) return invalid(c);
    const versionId = decodeId("tsv", id.data);
    const verdict = await consumeRateLimit(deps, PRACTICE_BY_USER, `${actor.userId}:${versionId}`);
    if (!verdict.allowed) return refuseRateLimited(c, verdict);
    const tx = c.get("tx");
    const made = await createPractice(tx, {
        versionId,
        language: body.data.language,
        source: body.data.source,
        nowMs: deps.clock.nowUnixMs(),
    });
    if ("refused" in made) {
        if (made.refused === "unknown") return notFound(c);
        if (made.refused === "language") return invalid(c);
        if (made.refused === "contest")
            return problemResponse(
                c,
                "conflict",
                "This problem is part of a contest that has not ended",
            );
        if (made.refused === "too_large")
            return problemResponse(c, "payload_too_large", "The source is too large");
        return problemResponse(c, "unavailable", "The judges are busy; try again shortly");
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: null,
        action: "practice.submission_created",
        target: encodeId("sub", made.id),
        detail: { language: body.data.language, bytes: Buffer.byteLength(body.data.source) },
    });
    const row = await getSubmission(tx, made.id);
    if (row === null) throw new Error("a new submission is visible to its owner");
    return c.json(submissionBody(row, null), 201);
}

async function handleCurate(
    c: Context<AppEnv>,
    deps: SubmissionRouteDeps,
    action: "list" | "unlist",
) {
    const actor = c.get("actor");
    if (actor.kind === "anonymous")
        return problemResponse(c, "unauthenticated", "Authentication required");
    // Like the other platform routes: to anyone who is not an administrator this route does not exist.
    if (actor.kind !== "user" || actor.platformRole !== "admin") return notFound(c);
    if (!hasFreshStepUp(actor.stepUpAtMs, deps.clock.nowUnixMs())) {
        return problemResponse(c, "step_up_required", "Confirm with your passkey to continue");
    }
    const raw =
        action === "list"
            ? practiceListRequestSchema.safeParse(await c.req.json().catch(() => null))
            : idSchema("tsv").safeParse(c.req.param("id"));
    if (!raw.success) return invalid(c);
    const versionId = decodeId(
        "tsv",
        typeof raw.data === "string" ? raw.data : raw.data.task_version_id,
    );
    const tx = c.get("tx");
    try {
        if (action === "list")
            await tx`select practice_list_version(${versionId}, ${new Date(deps.clock.nowUnixMs())})`;
        else await tx`select practice_unlist_version(${versionId})`;
    } catch (error) {
        if (postgresErrorCode(error) === "P0002") return notFound(c);
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: null,
        action: action === "list" ? "practice.listed" : "practice.unlisted",
        target: encodeId("tsv", versionId),
    });
    return c.body(null, 204);
}
