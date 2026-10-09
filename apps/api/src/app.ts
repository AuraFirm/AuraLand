import { randomUUID } from "node:crypto";
import { assert, InvariantError } from "@aura/contracts/assert";
import { ERROR_STATUS, type ErrorCode } from "@aura/contracts/errors";
import { REQUEST_BODY_BYTES_MAX, REQUEST_ID_LENGTH_MAX } from "@aura/contracts/limits";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { Config } from "./config.ts";
import { READINESS_CHECK_TIMEOUT_MS_MAX } from "./limits.ts";
import { assertPipelineOrder, type PipelineName } from "./pipeline.ts";
import type { Clock } from "./platform/clock.ts";
import type { Logger } from "./platform/log.ts";
import { buildProblem } from "./platform/problem.ts";

export interface AppDeps {
    readonly config: Config;
    readonly logger: Logger;
    readonly clock: Clock;
    // Rejects when the database is unreachable. Must be cheap (a `select 1`).
    readonly pingDatabase: () => Promise<void>;
    // Called after an invariant violation, when state may be corrupt: the process should stop.
    readonly onInvariantViolation: () => void;
}

export interface AppEnv {
    Variables: { requestId: string };
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

// Accepts any context because Hono's body-limit hook is not typed with our environment.
function problemResponse(c: Context, code: ErrorCode, title: string, detail?: string) {
    const requestId = c.get("requestId");
    const body = buildProblem(
        code,
        title,
        typeof requestId === "string" ? requestId : "unknown",
        detail,
    );
    return c.json(body, ERROR_STATUS[code], { "Content-Type": "application/problem+json" });
}

function requestIdMiddleware(trustEdge: boolean): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const inbound = c.req.header("x-request-id");
        const accepted =
            trustEdge &&
            inbound !== undefined &&
            inbound.length <= REQUEST_ID_LENGTH_MAX &&
            REQUEST_ID_PATTERN.test(inbound);
        const requestId = accepted ? inbound : randomUUID();
        c.set("requestId", requestId);
        await next();
        c.header("X-Request-Id", requestId);
    };
}

function accessLogMiddleware(deps: AppDeps): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const startMs = deps.clock.nowUnixMs();
        await next();
        deps.logger.info({
            request_id: c.get("requestId"),
            method: c.req.method,
            route: c.req.routePath,
            status: c.res.status,
            latency_ms: deps.clock.nowUnixMs() - startMs,
        });
    };
}

// This API serves JSON only, so the policy is the strictest possible: nothing may load or frame.
function securityHeadersMiddleware(): MiddlewareHandler<AppEnv> {
    const headers = secureHeaders({
        contentSecurityPolicy: {
            defaultSrc: ["'none'"],
            baseUri: ["'none'"],
            formAction: ["'none'"],
            frameAncestors: ["'none'"],
        },
        strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
        xContentTypeOptions: "nosniff",
        xFrameOptions: "DENY",
        referrerPolicy: "no-referrer",
        crossOriginOpenerPolicy: "same-origin",
        crossOriginResourcePolicy: "same-site",
    });
    return async (c, next) => {
        await headers(c, next);
        // Responses are personal or time-sensitive by default; routes opt in to caching.
        if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
    };
}

function bodyLimitMiddleware(): MiddlewareHandler<AppEnv> {
    return bodyLimit({
        maxSize: REQUEST_BODY_BYTES_MAX,
        onError: (c) => problemResponse(c, "payload_too_large", "Payload too large"),
    });
}

async function pingWithTimeout(ping: () => Promise<void>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), READINESS_CHECK_TIMEOUT_MS_MAX);
    });
    try {
        return await Promise.race([ping().then(() => true as const), timeout]);
    } catch {
        // Any failure means "not ready"; the cause belongs in the database's own metrics.
        return false;
    } finally {
        clearTimeout(timer);
    }
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
    const app = new Hono<AppEnv>().basePath("/api");
    const registered: PipelineName[] = [];
    const use = (name: PipelineName, middleware: MiddlewareHandler<AppEnv>) => {
        registered.push(name);
        app.use("*", middleware);
    };
    use("requestId", requestIdMiddleware(deps.config.AURA_TRUST_EDGE_REQUEST_ID));
    use("accessLog", accessLogMiddleware(deps));
    use("securityHeaders", securityHeadersMiddleware());
    use("bodyLimit", bodyLimitMiddleware());
    assertPipelineOrder(registered);

    // Liveness: the process is up. It must not touch dependencies, or an outage restarts everything.
    app.get("/healthz", (c) => c.json({ status: "ok" }));
    // Readiness: safe to receive traffic, meaning the database answers.
    app.get("/readyz", async (c) => {
        if (await pingWithTimeout(deps.pingDatabase)) return c.json({ status: "ready" });
        return problemResponse(c, "unavailable", "Service unavailable");
    });

    app.notFound((c) => problemResponse(c, "not_found", "Not found"));
    app.onError((error, c) => mapError(error, c, deps));
    return app;
}

function mapError(error: Error, c: Context<AppEnv>, deps: AppDeps) {
    const requestId = c.get("requestId");
    if (error instanceof HTTPException) {
        return problemResponse(
            c,
            error.status === 413 ? "payload_too_large" : "invalid_request",
            "Bad request",
        );
    }
    if (error instanceof InvariantError) {
        // State may be corrupt: answer this request safely, then ask the process to stop.
        deps.logger.fatal({ request_id: requestId, err: error }, "invariant violation");
        deps.onInvariantViolation();
    } else {
        deps.logger.error({ request_id: requestId, err: error }, "unhandled error");
    }
    assert(requestId !== undefined, "request id is set before any handler runs");
    return problemResponse(c, "internal", "Internal error");
}
