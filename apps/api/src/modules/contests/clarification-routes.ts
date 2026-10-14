import {
    clarificationAnswerRequestSchema,
    clarificationAskRequestSchema,
    clarificationListQuerySchema,
    clarificationSchema,
    clarificationsResponseSchema,
} from "@aura/contracts/api/clarifications";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { CLARIFICATIONS_PER_MINUTE_PER_USER_MAX } from "@aura/contracts/limits";
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
import * as clarifications from "./clarification-queries.ts";
import { getContest } from "./queries.ts";

export type ClarificationRouteDeps = Pick<RateLimitDeps, "sql" | "clock" | "key">;

const ASK_BY_USER: RateLimitRule = {
    name: "clarification-ask:user",
    max: CLARIFICATIONS_PER_MINUTE_PER_USER_MAX,
    windowS: 60,
};

// Clarifications: plain-text questions to a contest's organizers and their answers. Who may ask and answer
// is decided by the functions of migration 0039, who may read by its policy; these routes translate.
export function clarificationRoutes(deps: ClarificationRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/contests/:id/clarifications", handleList);
    routes.post("/contests/:id/clarifications", (c) => handleAsk(c, deps));
    routes.post("/contests/:id/clarifications/:clarification_id/answer", (c) =>
        handleAnswer(c, deps),
    );
    return routes;
}

const invalid = (c: Context<AppEnv>) => problemResponse(c, "invalid_request", "Invalid request");
const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");

function contestIdOf(c: Context<AppEnv>): string | null {
    const parsed = idSchema("cst").safeParse(c.req.param("id"));
    return parsed.success ? decodeId("cst", parsed.data) : null;
}

const bodyOf = (row: clarifications.ClarificationRow) =>
    clarificationSchema.parse({
        id: encodeId("clr", row.id),
        problem: row.problem_label,
        question: row.question,
        answer: row.answer,
        public: row.public,
        mine: row.mine,
        created_at: row.created_at.toISOString(),
        answered_at: row.answered_at?.toISOString() ?? null,
    });

async function handleList(c: Context<AppEnv>) {
    const contest = contestIdOf(c);
    const query = clarificationListQuerySchema.safeParse(c.req.query());
    if (contest === null || !query.success) return invalid(c);
    const tx = c.get("tx");
    if ((await getContest(tx, contest)) === null) return notFound(c);
    const page = await clarifications.list(tx, {
        contestId: contest,
        cursor: query.data.cursor === undefined ? null : decodeId("clr", query.data.cursor),
        limit: query.data.limit,
    });
    const last = page.rows[page.rows.length - 1];
    return c.json(
        clarificationsResponseSchema.parse({
            items: page.rows.map(bodyOf),
            next_cursor: page.hasMore && last !== undefined ? encodeId("clr", last.id) : null,
        }),
    );
}

async function handleAsk(c: Context<AppEnv>, deps: ClarificationRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const contest = contestIdOf(c);
    const body = clarificationAskRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (contest === null || !body.success) return invalid(c);
    const verdict = await consumeRateLimit(deps, ASK_BY_USER, actor.userId);
    if (!verdict.allowed) return refuseRateLimited(c, verdict);
    const tx = c.get("tx");
    const outcome = await clarifications.ask(tx, {
        contestId: contest,
        problem: body.data.problem,
        question: body.data.question,
        nowMs: deps.clock.nowUnixMs(),
    });
    if (outcome.kind === "refused") {
        if (outcome.why === "unknown") return notFound(c);
        if (outcome.why === "closed")
            return problemResponse(c, "conflict", "The contest is not accepting questions");
        if (outcome.why === "too_long") return invalid(c);
        return problemResponse(c, "rate_limited", "You have asked as many questions as allowed");
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: null,
        action: "contest.clarification_asked",
        target: encodeId("clr", outcome.id),
        detail: { contest: encodeId("cst", contest) },
    });
    const row = await clarifications.getOne(tx, outcome.id);
    if (row === null) throw new Error("the asker can read their own question");
    return c.json(bodyOf(row), 201);
}

async function handleAnswer(c: Context<AppEnv>, deps: ClarificationRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const contest = contestIdOf(c);
    const target = idSchema("clr").safeParse(c.req.param("clarification_id"));
    const body = clarificationAnswerRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (contest === null || !target.success || !body.success) return invalid(c);
    const tx = c.get("tx");
    const id = decodeId("clr", target.data);
    const existing = await clarifications.getOne(tx, id);
    // The question must belong to the contest in the address, or the address lies.
    if (existing === null || !(await belongsTo(tx, id, contest))) return notFound(c);
    const outcome = await clarifications.answer(tx, {
        id,
        answer: body.data.answer,
        public: body.data.public,
        nowMs: deps.clock.nowUnixMs(),
    });
    if (outcome.kind === "refused") {
        if (outcome.why === "unknown") return notFound(c);
        return problemResponse(c, "conflict", "This question cannot be answered now");
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: null,
        action: "contest.clarification_answered",
        target: encodeId("clr", id),
        detail: { contest: encodeId("cst", contest), public: body.data.public },
    });
    const row = await clarifications.getOne(tx, id);
    if (row === null) throw new Error("the answering staff can read the question");
    return c.json(bodyOf(row));
}

async function belongsTo(
    tx: Parameters<typeof clarifications.getOne>[0],
    id: string,
    contestId: string,
): Promise<boolean> {
    const rows = await tx`select 1 as found from contest_clarifications
        where id = ${id} and contest_id = ${contestId}`;
    return rows.length === 1;
}
