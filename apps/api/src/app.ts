import { randomUUID } from "node:crypto";
import { serverTimeSchema } from "@aura/contracts/api/contests";
import { assert, InvariantError } from "@aura/contracts/assert";
import {
    REQUEST_BODY_BYTES_MAX,
    REQUEST_ID_LENGTH_MAX,
    SUBMISSION_SOURCE_BYTES_MAX,
} from "@aura/contracts/limits";
import type { Database } from "@aura/db/client";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv } from "./app-env.ts";
import { authenticate, csrf, dbContext } from "./auth-middleware.ts";
import { type Config, loginTokenKey, usesSecureCookies } from "./config.ts";
import { READINESS_CHECK_TIMEOUT_MS_MAX } from "./limits.ts";
import { clarificationRoutes } from "./modules/contests/clarification-routes.ts";
import { ratingRoutes } from "./modules/contests/rating-routes.ts";
import { contestRoutes } from "./modules/contests/routes.ts";
import { createScoreboardListener } from "./modules/contests/scoreboard-listener.ts";
import {
    defaultHub,
    SCOREBOARD_STREAM_DEFAULTS,
    scoreboardRoutes,
} from "./modules/contests/scoreboard-routes.ts";
import { gradingRoutes } from "./modules/exams/grading-routes.ts";
import { examRoutes } from "./modules/exams/routes.ts";
import { sessionRoutes } from "./modules/exams/session-routes.ts";
import { accountRoutes } from "./modules/identity/account-routes.ts";
import { adminRoutes } from "./modules/identity/admin-routes.ts";
import { apiKeyRoutes } from "./modules/identity/api-key-routes.ts";
import { invitationRoutes } from "./modules/identity/invitation-routes.ts";
import type { OAuthProvider, ProviderName } from "./modules/identity/oauth-providers.ts";
import { oauthRoutes } from "./modules/identity/oauth-routes.ts";
import { orgRoutes } from "./modules/identity/org-routes.ts";
import { relyingPartyId } from "./modules/identity/passkey.ts";
import { passkeyRoutes } from "./modules/identity/passkey-routes.ts";
import { identityRoutes } from "./modules/identity/routes.ts";
import { signInRoutes } from "./modules/identity/sign-in-routes.ts";
import { judgeAdminRoutes } from "./modules/judge/admin-routes.ts";
import { judgeRoutes } from "./modules/judge/routes.ts";
import { deliveryRoutes } from "./modules/orders/delivery-routes.ts";
import { orderRoutes } from "./modules/orders/routes.ts";
import { payoutRoutes } from "./modules/payouts/routes.ts";
import { contestSubmissionRoutes } from "./modules/submissions/contest-routes.ts";
import { examProblemRoutes } from "./modules/submissions/exam-routes.ts";
import { practiceRoutes } from "./modules/submissions/practice-routes.ts";
import {
    QUEUE_FULL_RETRY_AFTER_S,
    QueueFullError,
    submissionRoutes,
} from "./modules/submissions/routes.ts";
import { assignmentRoutes } from "./modules/tasks/assignment-routes.ts";
import { attackRoutes } from "./modules/tasks/attack-routes.ts";
import { commentRoutes } from "./modules/tasks/comment-routes.ts";
import { reviewRoutes } from "./modules/tasks/review-routes.ts";
import { taskRoutes } from "./modules/tasks/task-routes.ts";
import { versionRoutes } from "./modules/tasks/version-routes.ts";
import { validationRoutes } from "./modules/validation/routes.ts";
import { assertPipelineOrder, type PipelineName } from "./pipeline.ts";
import type { Clock } from "./platform/clock.ts";
import type { Logger } from "./platform/log.ts";
import type { MailPort } from "./platform/mail.ts";
import { type ObjectStorage, StorageUnavailableError } from "./platform/object-storage.ts";
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
    // Where task bundles live; the in-memory adapter is for tests only.
    readonly storage: ObjectStorage;
    // The OAuth providers that are switched on; empty when none is configured.
    readonly oauthProviders: ReadonlyMap<ProviderName, OAuthProvider>;
    // Rejects when the database is unreachable. Must be cheap (a `select 1`).
    readonly pingDatabase: () => Promise<void>;
    // Called after an invariant violation, when state may be corrupt: the process should stop.
    readonly onInvariantViolation: () => void;
    // Scoreboard stream timing; tests shorten it. Production uses the defaults.
    readonly scoreboardStream?: { readonly heartbeatMs: number; readonly lifetimeMs: number };
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

// Source code is the one body that can legitimately exceed the general cap: 256 KiB of source can
// take up to six times that once JSON-escaped. The route's schema still enforces the exact limit on
// the decoded text; this only keeps the transport limit from cutting valid submissions off.
const SUBMISSION_PATH = /^\/api\/v1\/task-versions\/[^/]+\/submissions$/;
const SUBMISSION_BODY_BYTES_MAX = 6 * SUBMISSION_SOURCE_BYTES_MAX + 1024;

function bodyLimitMiddleware(): MiddlewareHandler<AppEnv> {
    const refuse = (c: Context) => problemResponse(c, "payload_too_large", "Payload too large");
    const general = bodyLimit({ maxSize: REQUEST_BODY_BYTES_MAX, onError: refuse });
    const sources = bodyLimit({ maxSize: SUBMISSION_BODY_BYTES_MAX, onError: refuse });
    return (c, next) => (SUBMISSION_PATH.test(c.req.path) ? sources(c, next) : general(c, next));
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
        "/v1/*",
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
        accountRoutes({
            clock: deps.clock,
            emailEnabled: deps.config.AURA_MAIL_DRIVER !== "disabled",
            oauthProviders: [...deps.oauthProviders.keys()],
            secureCookies,
        }),
    );
    app.route("/v1", apiKeyRoutes({ clock: deps.clock, rng: deps.rng }));
    app.route("/v1", adminRoutes({ clock: deps.clock, sql: deps.database.sql }));
    app.route(
        "/v1",
        invitationRoutes({
            sql: deps.database.sql,
            clock: deps.clock,
            rng: deps.rng,
            key: loginTokenKey(deps.config),
            mail: deps.mail,
            publicOrigin: deps.config.AURA_PUBLIC_ORIGIN,
        }),
    );
    app.route(
        "/v1",
        orgRoutes({ sql: deps.database.sql, clock: deps.clock, key: loginTokenKey(deps.config) }),
    );
    app.route(
        "/v1",
        taskRoutes({ sql: deps.database.sql, clock: deps.clock, key: loginTokenKey(deps.config) }),
    );
    app.route("/v1", versionRoutes({ clock: deps.clock, rng: deps.rng, storage: deps.storage }));
    app.route("/v1", reviewRoutes({ clock: deps.clock }));
    app.route("/v1", assignmentRoutes({ clock: deps.clock }));
    app.route("/v1", validationRoutes());
    mountDiscussionRoutes(app, deps);
    app.route("/v1", judgeAdminRoutes({ clock: deps.clock }));
    app.route(
        "/judge/v1",
        judgeRoutes({
            sql: deps.database.sql,
            clock: deps.clock,
            key: loginTokenKey(deps.config),
            trustEdge: deps.config.AURA_TRUST_EDGE_REQUEST_ID,
            rng: deps.rng,
            storage: deps.storage,
        }),
    );
    app.route(
        "/v1",
        practiceRoutes({
            sql: deps.database.sql,
            clock: deps.clock,
            key: loginTokenKey(deps.config),
        }),
    );
    app.route(
        "/v1",
        submissionRoutes({
            sql: deps.database.sql,
            clock: deps.clock,
            key: loginTokenKey(deps.config),
        }),
    );
    mountOrderRoutes(app, deps);
    mountSignInRoutes(app, deps, secureCookies);
}

// Talk about and test a task version: comments and human attacks (Stage 4).
// Exams: the instructor's side and the candidate's own sitting.
function mountExamRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
    app.route("/v1", examRoutes({ clock: deps.clock }));
    app.route("/v1", sessionRoutes({ clock: deps.clock }));
    app.route("/v1", gradingRoutes({ clock: deps.clock }));
    app.route("/v1", examProblemRoutes());
}

function mountDiscussionRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
    // The server's clock, for countdowns on the page: a person's own clock may be minutes off.
    app.get("/v1/time", (c) => {
        const nowMs = deps.clock.nowUnixMs();
        c.header("Cache-Control", "no-store");
        return c.json(
            serverTimeSchema.parse({ now: new Date(nowMs).toISOString(), now_ms: nowMs }),
        );
    });
    mountExamRoutes(app, deps);
    app.route("/v1", ratingRoutes());
    const hub = defaultHub();
    app.route(
        "/v1",
        scoreboardRoutes({
            sql: deps.database.sql,
            hub,
            listener: createScoreboardListener(
                hub,
                (channel, onNotify, onListen) =>
                    deps.database.sql.listen(channel, onNotify, onListen),
                (payload) =>
                    deps.logger.warn({ length: payload.length }, "unreadable scoreboard notice"),
            ),
            trustEdge: deps.config.AURA_TRUST_EDGE_REQUEST_ID,
            ...(deps.scoreboardStream ?? SCOREBOARD_STREAM_DEFAULTS),
            monotonicMs: () => performance.now(),
        }),
    );
    app.route(
        "/v1",
        contestSubmissionRoutes({
            sql: deps.database.sql,
            clock: deps.clock,
            key: loginTokenKey(deps.config),
        }),
    );
    app.route(
        "/v1",
        clarificationRoutes({
            sql: deps.database.sql,
            clock: deps.clock,
            key: loginTokenKey(deps.config),
        }),
    );
    app.route(
        "/v1",
        contestRoutes({
            sql: deps.database.sql,
            clock: deps.clock,
            key: loginTokenKey(deps.config),
        }),
    );
    app.route(
        "/v1",
        commentRoutes({
            sql: deps.database.sql,
            clock: deps.clock,
            key: loginTokenKey(deps.config),
        }),
    );
    app.route(
        "/v1",
        attackRoutes({
            sql: deps.database.sql,
            clock: deps.clock,
            key: loginTokenKey(deps.config),
        }),
    );
}

// Selling and delivering tasks: orders, payment records and customer deliveries (Stage 4).
function mountOrderRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
    app.route("/v1", orderRoutes({ clock: deps.clock, rng: deps.rng }));
    app.route("/v1", payoutRoutes({ clock: deps.clock }));
    app.route(
        "/v1",
        deliveryRoutes({
            sql: deps.database.sql,
            clock: deps.clock,
            key: loginTokenKey(deps.config),
            storage: deps.storage,
            trustEdge: deps.config.AURA_TRUST_EDGE_REQUEST_ID,
        }),
    );
}

// The ways in: email, OAuth providers and passkeys.
function mountSignInRoutes(app: Hono<AppEnv>, deps: AppDeps, secureCookies: boolean): void {
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
    if (error instanceof QueueFullError) {
        c.header("Retry-After", String(QUEUE_FULL_RETRY_AFTER_S));
        return problemResponse(c, "unavailable", "The judge is busy, try again shortly");
    }
    if (error instanceof StorageUnavailableError) {
        // The request transaction rolls back, so nothing is half-recorded; the caller can retry.
        deps.logger.error({ request_id: requestId, err: error }, "object storage unavailable");
        return problemResponse(c, "unavailable", "Storage is unavailable, try again");
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
