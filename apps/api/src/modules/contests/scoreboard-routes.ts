import { createHash } from "node:crypto";
import { scoreboardBodySchema, scoreboardResponseSchema } from "@aura/contracts/api/scoreboard";
import { decodeId, idSchema } from "@aura/contracts/ids";
import {
    SCOREBOARD_STREAM_HEARTBEAT_MS,
    SCOREBOARD_STREAM_LIFETIME_MS,
    SCOREBOARD_STREAMS_PER_ADDRESS_MAX,
    SCOREBOARD_STREAMS_PER_CONTEST_MAX,
    SCOREBOARD_STREAMS_PER_INSTANCE_MAX,
    SCOREBOARD_STREAMS_PER_USER_MAX,
} from "@aura/contracts/limits";
import type { Sql } from "@aura/db/client";
import { withRequestContext } from "@aura/db/context";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import { contextFor } from "../../auth-middleware.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { clientAddress } from "../../request-info.ts";
import * as q from "./queries.ts";
import { createRenderCache, type RenderCache } from "./scoreboard-cache.ts";
import { toIcpcScoreboard } from "./scoreboard-export.ts";
import {
    createScoreboardHub,
    type ScoreboardHub,
    type ScoreboardViewName,
    type Subscription,
} from "./scoreboard-hub.ts";
import type { ScoreboardListener } from "./scoreboard-listener.ts";

export interface ScoreboardRouteDeps {
    readonly sql: Sql;
    readonly hub: ScoreboardHub;
    readonly listener: ScoreboardListener;
    readonly trustEdge: boolean;
    readonly heartbeatMs: number;
    readonly lifetimeMs: number;
    // Real elapsed time (a stream's lifetime is wall time, not the injected clock's).
    readonly monotonicMs: () => number;
}

export function defaultHub(): ScoreboardHub {
    return createScoreboardHub({
        instanceMax: SCOREBOARD_STREAMS_PER_INSTANCE_MAX,
        contestMax: SCOREBOARD_STREAMS_PER_CONTEST_MAX,
        viewerMax: (viewer) =>
            viewer.startsWith("u:")
                ? SCOREBOARD_STREAMS_PER_USER_MAX
                : SCOREBOARD_STREAMS_PER_ADDRESS_MAX,
    });
}

export const SCOREBOARD_STREAM_DEFAULTS = {
    heartbeatMs: SCOREBOARD_STREAM_HEARTBEAT_MS,
    lifetimeMs: SCOREBOARD_STREAM_LIFETIME_MS,
} as const;

// The loop ends at the lifetime; this bounds it even if pings arrive faster than a tick can make them.
const STREAM_EVENTS_MAX = 10_000;
const CLIENT_RETRY_MS = 5_000;

const viewQuery = z.object({ view: z.enum(["public", "final"]).default("public") });

// Scoreboards: a cacheable snapshot and a stream of "a new version exists" pings. Who may read what is
// decided by the policy of migration 0036; these routes only choose headers and keep the streams bounded.
export function scoreboardRoutes(deps: ScoreboardRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    const cache = createRenderCache();
    routes.get("/contests/:id/scoreboard", (c) => handleSnapshot(c, cache));
    routes.get("/contests/:id/scoreboard/stream", (c) => handleStream(c, deps));
    routes.get("/contests/:id/standings.icpc.json", (c) => handleIcpcExport(c, cache));
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");

interface Request {
    readonly contestId: string;
    readonly view: ScoreboardViewName;
}

function parseRequest(c: Context<AppEnv>): Request | null {
    const id = idSchema("cst").safeParse(c.req.param("id"));
    const query = viewQuery.safeParse(c.req.query());
    if (!id.success || !query.success) return null;
    return { contestId: decodeId("cst", id.data), view: query.data.view };
}

// The final board is the host staff's: to anyone else it does not exist.
function mayRead(c: Context<AppEnv>, orgId: string, view: ScoreboardViewName): boolean {
    if (view === "public") return true;
    const actor = c.get("actor");
    const role =
        actor.kind === "user" ? actor.orgs.find((m) => m.orgId === orgId)?.role : undefined;
    return role === "owner" || role === "admin";
}

// The body names no user and is the same for everyone, so a shared cache may keep a public contest's
// public board for the one second the tick takes to make the next. Anything else is for this caller.
function cacheControlFor(contest: q.ContestRow, view: ScoreboardViewName): string {
    const shared = contest.visibility === "public" && view === "public";
    return shared ? "public, max-age=0, s-maxage=1" : "private, no-cache";
}

// Both readers of a stored board work the same way: check the caller may see the contest and the view, read
// only the board's stamp, answer 304 if the caller has it, and otherwise serve the text built for that stamp
// (built once, then kept: see scoreboard-cache.ts).
interface Reading {
    readonly contest: q.ContestRow;
    readonly request: Request;
    readonly stamp: { version: number; etag: string; updated_at: Date };
}

async function readStamp(c: Context<AppEnv>): Promise<Reading | Response> {
    const request = parseRequest(c);
    if (request === null) return problemResponse(c, "invalid_request", "Invalid request");
    const tx = c.get("tx");
    const contest = await q.getContest(tx, request.contestId);
    if (contest === null || !mayRead(c, contest.org_id, request.view)) return notFound(c);
    const stamp = await q.getScoreboardStamp(tx, request.contestId, request.view);
    if (stamp === null) return notFound(c); // not started, or the first tick has not run yet
    return { contest, request, stamp };
}

async function serveCached(
    c: Context<AppEnv>,
    cache: RenderCache,
    reading: Reading,
    input: { key: string; etag: string; build: () => Promise<unknown> },
): Promise<Response> {
    const quoted = `"${input.etag}"`;
    c.header("ETag", quoted);
    c.header("Cache-Control", cacheControlFor(reading.contest, reading.request.view));
    if (c.req.header("if-none-match") === quoted) return c.body(null, 304);
    let text = cache.get(input.key, input.etag);
    if (text === null) {
        text = JSON.stringify(await input.build());
        cache.set(input.key, input.etag, text);
    }
    c.header("Vary", "Accept-Encoding");
    const compressed = /\bgzip\b/.test(c.req.header("accept-encoding") ?? "")
        ? cache.gzipped(input.key, input.etag)
        : null;
    if (compressed === null) {
        return c.body(text, 200, { "Content-Type": "application/json; charset=UTF-8" });
    }
    return c.body(compressed, 200, {
        "Content-Type": "application/json; charset=UTF-8",
        "Content-Encoding": "gzip",
    });
}

async function handleSnapshot(c: Context<AppEnv>, cache: RenderCache) {
    const reading = await readStamp(c);
    if (reading instanceof Response) return reading;
    const { contest, request, stamp } = reading;
    return serveCached(c, cache, reading, {
        key: `snapshot:${contest.id}:${request.view}`,
        etag: stamp.etag,
        build: async () => {
            const row = await q.getScoreboard(c.get("tx"), contest.id, request.view);
            if (row === null) throw new Error("a board that had a stamp has a body");
            return scoreboardResponseSchema.parse({
                ...scoreboardBodySchema.parse(row.body),
                version: row.version,
                etag: row.etag,
                updated_at: row.updated_at.toISOString(),
            });
        },
    });
}

// The ICPC Contest API scoreboard of a stored board, for ICPC tools (resolvers, spotlights, archives). Its
// content also depends on the contest's state and dates, which the board's etag does not cover, so its own
// etag covers both.
async function handleIcpcExport(c: Context<AppEnv>, cache: RenderCache) {
    const reading = await readStamp(c);
    if (reading instanceof Response) return reading;
    const { contest, request, stamp } = reading;
    if (contest.format !== "icpc") return notFound(c); // see scoreboard-export.ts
    const etag = createHash("sha256")
        .update(
            [
                stamp.etag,
                contest.state,
                contest.unfrozen_at?.getTime(),
                contest.finalized_at?.getTime(),
            ].join("|"),
        )
        .digest("hex");
    return serveCached(c, cache, reading, {
        key: `icpc:${contest.id}:${request.view}`,
        etag,
        build: async () => {
            const row = await q.getScoreboard(c.get("tx"), contest.id, request.view);
            if (row === null) throw new Error("a board that had a stamp has a body");
            return toIcpcScoreboard(scoreboardBodySchema.parse(row.body), {
                startsAt: contest.starts_at,
                endsAt: contest.ends_at,
                freezeAt: contest.freeze_at,
                unfrozenAt: contest.unfrozen_at,
                finalizedAt: contest.finalized_at,
                state: contest.state,
                generatedAt: row.updated_at,
            });
        },
    });
}

function viewerOf(c: Context<AppEnv>, trustEdge: boolean): string {
    const actor = c.get("actor");
    if (actor.kind === "user") return `u:${actor.userId}`;
    return `a:${clientAddress(c, trustEdge) ?? "unknown"}`;
}

async function handleStream(c: Context<AppEnv>, deps: ScoreboardRouteDeps) {
    const request = parseRequest(c);
    if (request === null) return problemResponse(c, "invalid_request", "Invalid request");
    const contest = await q.getContest(c.get("tx"), request.contestId);
    if (contest === null || !mayRead(c, contest.org_id, request.view)) return notFound(c);
    try {
        await deps.listener.ensureListening();
    } catch {
        return problemResponse(c, "unavailable", "Live updates are unavailable; read the snapshot");
    }
    const joined = deps.hub.subscribe(request.contestId, request.view, viewerOf(c, deps.trustEdge));
    if (!joined.ok) {
        c.header("Retry-After", "30");
        return problemResponse(c, "rate_limited", "Too many open streams");
    }
    // Subscribed before the first read, so a board stored in between is not missed.
    const first = await q.getScoreboard(c.get("tx"), request.contestId, request.view);
    const context = contextFor(c.get("actor"));
    const reread = () =>
        withRequestContext(deps.sql, context, async (tx) => {
            const visible = await q.getContest(tx, request.contestId);
            if (visible === null) return null;
            return q.getScoreboard(tx, request.contestId, request.view);
        });
    return streamSSE(c, async (stream) => {
        stream.onAbort(() => joined.subscription.close());
        try {
            await relay(
                stream,
                joined.subscription,
                deps,
                first?.version ?? 0,
                first?.etag ?? null,
                reread,
            );
        } finally {
            joined.subscription.close();
        }
    });
}

interface Writer {
    writeSSE(message: { data: string; event?: string; id?: string; retry?: number }): Promise<void>;
    write(text: string): Promise<unknown>;
    readonly aborted: boolean;
}

async function relay(
    stream: Writer,
    subscription: Subscription,
    deps: ScoreboardRouteDeps,
    firstVersion: number,
    firstEtag: string | null,
    reread: () => Promise<{ version: number; etag: string } | null>,
): Promise<void> {
    const startedMs = deps.monotonicMs();
    const send = (version: number, etag: string | null) =>
        stream.writeSSE({
            event: "version",
            id: String(version),
            data: JSON.stringify({ version, etag }),
            retry: CLIENT_RETRY_MS,
        });
    subscription.seen(firstVersion);
    await send(firstVersion, firstEtag);
    let sent = firstVersion;
    for (let events = 0; events < STREAM_EVENTS_MAX; events++) {
        const remainingMs = deps.lifetimeMs - (deps.monotonicMs() - startedMs);
        if (remainingMs < 1 || stream.aborted) return;
        const wake = await subscription.wait(Math.min(deps.heartbeatMs, remainingMs));
        if (wake.kind === "closed") return;
        if (wake.kind === "timeout") {
            await stream.write(": keepalive\n\n");
        } else if (wake.kind === "update") {
            sent = wake.ping.version;
            await send(wake.ping.version, wake.ping.etag);
        } else {
            // Re-authorized by reading as the caller; a contest that vanished ends the stream.
            const row = await reread();
            if (row === null) return;
            if (row.version > sent) {
                sent = row.version;
                subscription.seen(sent);
                await send(row.version, row.etag);
            }
        }
    }
}
