import { withRequestContext } from "@aura/db/context";
import type { MiddlewareHandler } from "hono";
import type { AppDeps } from "./app.ts";
import type { Actor, AppEnv } from "./app-env.ts";
import { usesSecureCookies } from "./config.ts";
import { CSRF_HEADER_NAME } from "./modules/identity/limits.ts";
import { loadMemberships } from "./modules/identity/org-queries.ts";
import { createPgSessionStore } from "./modules/identity/queries.ts";
import {
    evaluateCsrf,
    parseSessionCookie,
    serializeClearedCookie,
    sessionCookieName,
} from "./modules/identity/rules.ts";
import { validateSession } from "./modules/identity/service.ts";
import { problemResponse } from "./platform/problem-response.ts";

// The three request-scoped steps that sit between the edge middleware and the route handlers, in
// the order pipeline.ts requires: authenticate (who is this?), csrf (did our own page send this?),
// dbContext (open the transaction, as the right database role, for the handler).

const ANONYMOUS: Actor = { kind: "anonymous" };

export function authenticate(deps: AppDeps): MiddlewareHandler<AppEnv> {
    const secure = usesSecureCookies(deps.config);
    return async (c, next) => {
        const header = c.req.header("cookie");
        const token = parseSessionCookie(header, secure);
        c.set("actor", ANONYMOUS);
        c.set("clearSessionCookie", false);
        if (token !== null) {
            const result = await withRequestContext(
                deps.database.sql,
                { role: "aura_auth", actorKind: "anonymous", userId: null, orgIds: [] },
                async (tx) => {
                    const validated = await validateSession(
                        { store: createPgSessionStore(tx), clock: deps.clock, rng: deps.rng },
                        token,
                    );
                    if (!validated.ok) return { validated, orgs: [] };
                    return { validated, orgs: await loadMemberships(tx, validated.session.userId) };
                },
            );
            if (result.validated.ok) {
                const { session } = result.validated;
                c.set("actor", {
                    kind: "user",
                    userId: session.userId,
                    sessionId: session.id,
                    authMethod: session.authMethod,
                    privileged: session.privileged,
                    stepUpAtMs: session.stepUpAtMs,
                    orgs: result.orgs,
                });
            } else {
                c.set("clearSessionCookie", true);
            }
        } else if (header?.includes(`${sessionCookieName(secure)}=`)) {
            // A cookie of ours that we refused to read (duplicate, malformed): tell the browser to drop it.
            c.set("clearSessionCookie", true);
        }
        await next();
        if (c.get("clearSessionCookie")) c.header("Set-Cookie", serializeClearedCookie(secure));
    };
}

export function csrf(deps: AppDeps): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const verdict = evaluateCsrf({
            method: c.req.method,
            origin: c.req.header("origin") ?? null,
            secFetchSite: c.req.header("sec-fetch-site") ?? null,
            requestHeader: c.req.header(CSRF_HEADER_NAME) ?? null,
            allowedOrigin: deps.config.AURA_PUBLIC_ORIGIN,
        });
        if (!verdict.ok) {
            // The reason goes to the log for operators; the client only learns that it was refused.
            deps.logger.warn(
                { request_id: c.get("requestId"), reason: verdict.reason },
                "csrf refused",
            );
            return problemResponse(c, "forbidden", "Forbidden");
        }
        return next();
    };
}

const OWN_TRANSACTION_PREFIXES = [
    "/api/v1/auth/email/",
    "/api/v1/auth/passkey/",
    "/api/v1/auth/oauth/",
];

// Thrown after the handler has produced an error response, to roll the transaction back without
// turning that response into an exception.
class RollbackRequest extends Error {}

// Everything a handler writes happens in one transaction as `aura_app`. A response with status 400
// or above rolls it back, so a failed request leaves no half-written state behind. Flows that must
// persist something even when they fail (failed-login counters) use their own transaction.
export function dbContext(deps: AppDeps): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        // The sign-in and passkey ceremony endpoints run their own transactions as `aura_auth`.
        if (OWN_TRANSACTION_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))) return next();
        const actor = c.get("actor");
        const context =
            actor.kind === "user"
                ? ({
                      role: "aura_app",
                      actorKind: "user",
                      userId: actor.userId,
                      orgIds: actor.orgs.map((membership) => membership.orgId),
                  } as const)
                : ({ role: "aura_app", actorKind: "anonymous", userId: null, orgIds: [] } as const);
        try {
            await withRequestContext(deps.database.sql, context, async (tx) => {
                c.set("tx", tx);
                await next();
                if (c.res.status >= 400) throw new RollbackRequest();
            });
        } catch (error) {
            if (!(error instanceof RollbackRequest)) throw error;
        }
    };
}
