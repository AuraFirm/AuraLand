import {
    commentCreateRequestSchema,
    commentSchema,
    commentsResponseSchema,
} from "@aura/contracts/api/comments";
import { decodeId, encodeId } from "@aura/contracts/ids";
import { COMMENTS_PER_MINUTE_PER_USER_MAX } from "@aura/contracts/limits";
import { appendAudit } from "@aura/db/audit";
import { CHECK_VIOLATION, postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import { renderMarkdownSafe } from "../../platform/markdown.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { RateLimitRule } from "../../platform/rate-limit.ts";
import {
    consumeRateLimit,
    type RateLimitDeps,
    refuseRateLimited,
} from "../../rate-limit-middleware.ts";
import { type CommentRow, insertComment, listComments } from "./comment-queries.ts";
import { caller, invalid, notFound, readJson, unauthenticated } from "./route-support.ts";
import { getVersion } from "./version-queries.ts";
import { versionIdParam } from "./version-routes.ts";

export type CommentRouteDeps = Pick<RateLimitDeps, "sql" | "clock" | "key">;

const COMMENT_BY_USER: RateLimitRule = {
    name: "comment:user",
    max: COMMENTS_PER_MINUTE_PER_USER_MAX,
    windowS: 60,
};

// Row-level security decides who may read or write comments of a version. A person who cannot see the
// version gets 404 for the version before any comment is consulted; a person who sees the version but
// is not on its staff (a plain member of a released one) finds the insert refused by the database.
export function commentRoutes(deps: CommentRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/task-versions/:id/comments", handleList);
    routes.post("/task-versions/:id/comments", (c) => handleCreate(c, deps));
    return routes;
}

function commentBody(row: CommentRow) {
    return commentSchema.parse({
        id: encodeId("cmt", row.id),
        author_id: encodeId("usr", row.author_id),
        parent_id: row.parent_id === null ? null : encodeId("cmt", row.parent_id),
        body: row.body,
        body_html: renderMarkdownSafe(row.body).html,
        created_at: row.created_at.toISOString(),
    });
}

async function handleList(c: Context<AppEnv>) {
    if (caller(c) === null) return unauthenticated(c);
    const versionId = versionIdParam(c);
    if (versionId === null) return invalid(c);
    const tx = c.get("tx");
    if ((await getVersion(tx, versionId)) === null) return notFound(c);
    const rows = await listComments(tx, versionId);
    return c.json(commentsResponseSchema.parse({ comments: rows.map(commentBody) }));
}

async function handleCreate(c: Context<AppEnv>, deps: CommentRouteDeps) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const versionId = versionIdParam(c);
    const request = commentCreateRequestSchema.safeParse(await readJson(c));
    if (versionId === null || !request.success) return invalid(c);
    const tx = c.get("tx");
    const version = await getVersion(tx, versionId);
    if (version === null) return notFound(c);
    const verdict = await consumeRateLimit(deps, COMMENT_BY_USER, who.userId);
    if (!verdict.allowed) return refuseRateLimited(c, verdict);
    try {
        const row = await insertComment(tx, {
            orgId: version.org_id,
            versionId,
            authorId: who.userId,
            parentId:
                request.data.parent_id === undefined
                    ? null
                    : decodeId("cmt", request.data.parent_id),
            body: request.data.body,
            nowMs: deps.clock.nowUnixMs(),
        });
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: who.userId,
            orgId: version.org_id,
            action: "version.commented",
            target: encodeId("tsv", versionId),
            detail: { comment: encodeId("cmt", row.id), chars: row.body.length },
        });
        return c.json(commentBody(row), 201);
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === CHECK_VIOLATION) return invalid(c);
        // Row-level security refusal: the person may see the version but may not discuss it.
        if (code === "42501") return problemResponse(c, "forbidden", "Forbidden");
        throw error;
    }
}
