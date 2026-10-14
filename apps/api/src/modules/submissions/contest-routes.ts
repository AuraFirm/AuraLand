import {
    submissionCreateRequestSchema,
    submissionsResponseSchema,
} from "@aura/contracts/api/submissions";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import {
    CONTEST_SUBMISSIONS_PER_MINUTE_PER_USER_MAX,
    SUBMISSION_PAGE_SIZE_MAX,
} from "@aura/contracts/limits";
import { appendAudit } from "@aura/db/audit";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { RateLimitRule } from "../../platform/rate-limit.ts";
import { consumeRateLimit, refuseRateLimited } from "../../rate-limit-middleware.ts";
import { findVisibleContest } from "../contests/service.ts";
import { createContestSubmission, getSubmission, listMineInContest } from "./queries.ts";
import { type SubmissionRouteDeps, submissionBody } from "./routes.ts";

const SUBMIT_IN_CONTESTS: RateLimitRule = {
    name: "contest-submit:user",
    max: CONTEST_SUBMISSIONS_PER_MINUTE_PER_USER_MAX,
    windowS: 60,
};

// Contest submissions. The window, the registration, the language, the per-problem interval and the
// queue are decided by the database function (migration 0035) with the injected clock; this route
// translates its refusals and keeps the audit trail. A contestant never sees per-test results while the
// contest runs: the policy on verdict_details hides them, so the response carries an empty list.
export function contestSubmissionRoutes(deps: SubmissionRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/contests/:id/problems/:label/submissions", (c) => handleCreate(c, deps));
    routes.get("/contests/:id/submissions", handleList);
    return routes;
}

const contestId = (c: Context<AppEnv>): string | null => {
    const parsed = idSchema("cst").safeParse(c.req.param("id"));
    return parsed.success ? decodeId("cst", parsed.data) : null;
};

async function handleCreate(c: Context<AppEnv>, deps: SubmissionRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const contest = contestId(c);
    const label = c.req.param("label") ?? "";
    const body = submissionCreateRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (contest === null || !/^[A-Z][A-Z0-9]{0,2}$/.test(label) || !body.success) {
        return problemResponse(c, "invalid_request", "Invalid request");
    }
    const verdict = await consumeRateLimit(deps, SUBMIT_IN_CONTESTS, actor.userId);
    if (!verdict.allowed) return refuseRateLimited(c, verdict);
    const tx = c.get("tx");
    const nowMs = deps.clock.nowUnixMs();
    const outcome = await createContestSubmission(tx, {
        contestId: contest,
        label,
        language: body.data.language,
        source: body.data.source,
        nowMs,
    });
    if (outcome.kind === "refused") {
        if (outcome.why === "unknown") return problemResponse(c, "not_found", "Not found");
        if (outcome.why === "closed")
            return problemResponse(c, "conflict", "The contest is not accepting submissions");
        if (outcome.why === "language")
            return problemResponse(
                c,
                "invalid_request",
                "Invalid request",
                "that language is not allowed in this contest",
            );
        if (outcome.why === "too_large")
            return problemResponse(c, "payload_too_large", "The source is too large");
        if (outcome.why === "queue_full")
            return problemResponse(c, "unavailable", "The judges are busy; try again shortly");
        if (outcome.retryAfterS !== null) c.header("Retry-After", String(outcome.retryAfterS));
        return problemResponse(
            c,
            "rate_limited",
            "Too soon after your last submission to this problem",
        );
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: null,
        action: "contest.submission_created",
        target: encodeId("sub", outcome.id),
        detail: {
            contest: encodeId("cst", contest),
            label,
            language: body.data.language,
            bytes: Buffer.byteLength(body.data.source),
        },
    });
    const row = await getSubmission(tx, outcome.id);
    if (row === null) throw new Error("a new submission is visible to its owner");
    return c.json(submissionBody(row, null), 201);
}

const listQuery = z.object({
    limit: z.coerce.number().int().min(1).max(SUBMISSION_PAGE_SIZE_MAX).default(20),
    cursor: idSchema("sub").optional(),
});

async function handleList(c: Context<AppEnv>) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const contest = contestId(c);
    const query = listQuery.safeParse(c.req.query());
    if (contest === null || !query.success)
        return problemResponse(c, "invalid_request", "Invalid request");
    // A contest the caller cannot see does not exist for them, so this is a 404, not an empty list.
    if ((await findVisibleContest(c.get("tx"), contest)) === null) {
        return problemResponse(c, "not_found", "Not found");
    }
    const page = await listMineInContest(c.get("tx"), {
        contestId: contest,
        userId: actor.userId,
        cursor: query.data.cursor === undefined ? null : decodeId("sub", query.data.cursor),
        limit: query.data.limit,
    });
    const last = page.rows[page.rows.length - 1];
    return c.json(
        submissionsResponseSchema.parse({
            items: page.rows.map((row) => submissionBody(row, null)),
            next_cursor: page.hasMore && last !== undefined ? encodeId("sub", last.id) : null,
        }),
    );
}
