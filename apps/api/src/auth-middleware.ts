import { type ScopedContext, withRequestContext } from "@aura/db/context";
import type { Context, MiddlewareHandler } from "hono";
import type { AppDeps } from "./app.ts";
import type { Actor, AppEnv } from "./app-env.ts";
import { usesSecureCookies } from "./config.ts";
import { bearerKeyFrom, parseApiKey, secretMatches } from "./modules/identity/api-key.ts";
import { findKeyByPrefix, touchKey } from "./modules/identity/api-key-queries.ts";
import { CSRF_HEADER_NAME } from "./modules/identity/limits.ts";
import { loadMemberships, loadPlatformRole } from "./modules/identity/org-queries.ts";
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
const IDENTITY_CONTEXT = {
    role: "aura_auth",
    actorKind: "anonymous",
    userId: null,
    orgIds: [],
} as const;

// An API key's last-use time is written at most this often, so a busy integration does not turn
// every request into a write.
const KEY_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

// A constant to compare against when no key matches the prefix, so "unknown prefix" and "wrong
// secret" take the same time.
const DUMMY_HASH = "0".repeat(64);

export function authenticate(deps: AppDeps): MiddlewareHandler<AppEnv> {
    const secure = usesSecureCookies(deps.config);
    return async (c, next) => {
        c.set("actor", ANONYMOUS);
        c.set("clearSessionCookie", false);
        const bearer = bearerKeyFrom(c.req.header("authorization"));
        // A request that presents a key is judged by the key alone; a cookie sent beside it is ignored.
        if (bearer !== null) c.set("actor", await authenticateKey(deps, bearer));
        else await authenticateSession(c, deps, secure);
        await next();
        if (c.get("clearSessionCookie")) c.header("Set-Cookie", serializeClearedCookie(secure));
    };
}

async function authenticateSession(c: Context<AppEnv>, deps: AppDeps, secure: boolean) {
    const header = c.req.header("cookie");
    const token = parseSessionCookie(header, secure);
    if (token === null) {
        // A cookie of ours that we refused to read (duplicate, malformed): tell the browser to drop it.
        if (header?.includes(`${sessionCookieName(secure)}=`)) c.set("clearSessionCookie", true);
        return;
    }
    const result = await withRequestContext(deps.database.sql, IDENTITY_CONTEXT, async (tx) => {
        const validated = await validateSession(
            { store: createPgSessionStore(tx), clock: deps.clock, rng: deps.rng },
            token,
        );
        if (!validated.ok) return { validated, orgs: [], platformRole: "none" as const };
        const { userId } = validated.session;
        return {
            validated,
            orgs: await loadMemberships(tx, userId),
            platformRole: await loadPlatformRole(tx, userId),
        };
    });
    if (!result.validated.ok) {
        c.set("clearSessionCookie", true);
        return;
    }
    const { session } = result.validated;
    c.set("actor", {
        kind: "user",
        userId: session.userId,
        sessionId: session.id,
        authMethod: session.authMethod,
        privileged: session.privileged,
        stepUpAtMs: session.stepUpAtMs,
        orgs: result.orgs,
        platformRole: result.platformRole,
    });
}

async function authenticateKey(deps: AppDeps, presented: string): Promise<Actor> {
    const parsed = parseApiKey(presented);
    if (parsed === null) return ANONYMOUS;
    const nowMs = deps.clock.nowUnixMs();
    return withRequestContext(deps.database.sql, IDENTITY_CONTEXT, async (tx) => {
        const record = await findKeyByPrefix(tx, parsed.prefix);
        const matches = secretMatches(parsed.secret, record?.secretHash ?? DUMMY_HASH);
        if (record === null || !matches || record.revoked || record.expiresAtMs <= nowMs) {
            return ANONYMOUS;
        }
        const stale =
            record.lastUsedAtMs === null || nowMs - record.lastUsedAtMs >= KEY_TOUCH_INTERVAL_MS;
        if (stale) await touchKey(tx, record.id, nowMs);
        return { kind: "api_key", keyId: record.id, orgId: record.orgId, scopes: record.scopes };
    });
}

export function csrf(deps: AppDeps): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        // A key travels in a header the browser never adds by itself, so there is no ambient
        // credential for another site to ride on (ADR 0013, ADR 0018).
        if (c.get("actor").kind === "api_key") return next();
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
        const context = contextFor(actor);
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

function contextFor(actor: Actor): ScopedContext {
    if (actor.kind === "user") {
        const orgIds = actor.orgs.map((membership) => membership.orgId);
        return { role: "aura_app", actorKind: "user", userId: actor.userId, orgIds };
    }
    if (actor.kind === "api_key") {
        return { role: "aura_app", actorKind: "api_key", userId: null, orgIds: [actor.orgId] };
    }
    return { role: "aura_app", actorKind: "anonymous", userId: null, orgIds: [] };
}
