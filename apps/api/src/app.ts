import { randomUUID } from "node:crypto";
import { assert, InvariantError } from "@aura/contracts/assert";
import { REQUEST_BODY_BYTES_MAX, REQUEST_ID_LENGTH_MAX } from "@aura/contracts/limits";
import type { Database } from "@aura/db/client";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv } from "./app-env.ts";
import { authenticate, csrf, dbContext } from "./auth-middleware.ts";
import { type Config, loginTokenKey, usesSecureCookies } from "./config.ts";
import { READINESS_CHECK_TIMEOUT_MS_MAX } from "./limits.ts";
import type { OAuthProvider, ProviderName } from "./modules/identity/oauth-providers.ts";
import { oauthRoutes } from "./modules/identity/oauth-routes.ts";
import { orgRoutes } from "./modules/identity/org-routes.ts";
import { relyingPartyId } from "./modules/identity/passkey.ts";
import { passkeyRoutes } from "./modules/identity/passkey-routes.ts";
import { identityRoutes } from "./modules/identity/routes.ts";
import { signInRoutes } from "./modules/identity/sign-in-routes.ts";
import { assertPipelineOrder, type PipelineName } from "./pipeline.ts";
import type { Clock } from "./platform/clock.ts";
import type { Logger } from "./platform/log.ts";
import type { MailPort } from "./platform/mail.ts";
import { problemResponse } from "./platform/problem-response.ts";
import type { Rng } from "./platform/rng.ts";
import { rateLimit } from "./rate-limit-middleware.ts";

export interface AppDeps {
    readonly config: Config;
    readonly logger: Logger;
    readonly clock: Clock;
    readonly rng: Rng;
    readonly database: Database;
    readonly mail: MailPort;
    // The OAuth providers that are switched on; empty when none is configured.
    readonly oauthProviders: ReadonlyMap<ProviderName, OAuthProvider>;
    // Rejects when the database is unreachable. Must be cheap (a `select 1`).
    readonly pingDatabase: () => Promise<void>;
    // Called after an invariant violation, when state may be corrupt: the process should stop.
    readonly onInvariantViolation: () => void;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

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
    const use = (name: PipelineName, middleware: MiddlewareHandler<AppEnv>, path = "*") => {
        registered.push(name);
        app.use(path, middleware);
    };
    use("requestId", requestIdMiddleware(deps.config.AURA_TRUST_EDGE_REQUEST_ID));
    use("accessLog", accessLogMiddleware(deps));
    use("securityHeaders", securityHeadersMiddleware());
    use("bodyLimit", bodyLimitMiddleware());
    // Sign-in endpoints are anonymous and attractive to abuse, so they are counted before anything
    // else costs work.
    use(
        "rateLimit",
        rateLimit({
            sql: deps.database.sql,
            clock: deps.clock,
            key: loginTokenKey(deps.config),
            trustEdge: deps.config.AURA_TRUST_EDGE_REQUEST_ID,
        }),
        "/v1/auth/*",
    );
    // Everything under /v1 is the product API: identify the caller, refuse cross-site writes, and
    // give the handler its transaction. Health probes above and below it stay dependency-free.
    use("authenticate", authenticate(deps), "/v1/*");
    use("csrf", csrf(deps), "/v1/*");
    use("dbContext", dbContext(deps), "/v1/*");
    assertPipelineOrder(registered);
    mountProductRoutes(app, deps);

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

// The product API under /v1: identity and sessions, email sign-in, passkeys.
function mountProductRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
    const secureCookies = usesSecureCookies(deps.config);
    app.route("/v1", identityRoutes({ clock: deps.clock, secureCookies }));
    app.route(
        "/v1",
        orgRoutes({ sql: deps.database.sql, clock: deps.clock, key: loginTokenKey(deps.config) }),
    );
    app.route(
        "/v1",
        signInRoutes({
            sql: deps.database.sql,
            clock: deps.clock,
            rng: deps.rng,
            logger: deps.logger,
            mail: deps.mail,
            key: loginTokenKey(deps.config),
            publicOrigin: deps.config.AURA_PUBLIC_ORIGIN,
            secureCookies,
            trustEdge: deps.config.AURA_TRUST_EDGE_REQUEST_ID,
        }),
    );

    app.route(
        "/v1",
        oauthRoutes({
            sql: deps.database.sql,
            clock: deps.clock,
            rng: deps.rng,
            key: loginTokenKey(deps.config),
            publicOrigin: deps.config.AURA_PUBLIC_ORIGIN,
            logger: deps.logger,
            providers: deps.oauthProviders,
            secureCookies,
            trustEdge: deps.config.AURA_TRUST_EDGE_REQUEST_ID,
        }),
    );
    app.route(
        "/v1",
        passkeyRoutes({
            sql: deps.database.sql,
            clock: deps.clock,
            rng: deps.rng,
            rpId: relyingPartyId(deps.config.AURA_PUBLIC_ORIGIN),
            rpName: "AuraLand",
            origin: deps.config.AURA_PUBLIC_ORIGIN,
            secureCookies,
            trustEdge: deps.config.AURA_TRUST_EDGE_REQUEST_ID,
        }),
    );
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
