import type { Sql } from "@aura/db/client";
import { withRequestContext } from "@aura/db/context";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./app-env.ts";
import {
    LOGIN_START_PER_ADDRESS_PER_MINUTE_MAX,
    LOGIN_VERIFY_PER_ADDRESS_PER_MINUTE_MAX,
    OAUTH_PER_ADDRESS_PER_MINUTE_MAX,
    PASSKEY_LOGIN_PER_ADDRESS_PER_MINUTE_MAX,
} from "./modules/identity/limits.ts";
import type { Clock } from "./platform/clock.ts";
import { problemResponse } from "./platform/problem-response.ts";
import {
    checkRateLimit,
    createPgCounterStore,
    type RateLimitRule,
    type RateLimitVerdict,
} from "./platform/rate-limit.ts";
import { clientAddress } from "./request-info.ts";

// Strict limits for the anonymous sign-in endpoints. Counting happens in its own committed
// transaction (as `aura_auth`), so a refused or failed request still uses up its allowance.

export interface RateLimitDeps {
    readonly sql: Sql;
    readonly clock: Clock;
    readonly key: Buffer;
    readonly trustEdge: boolean;
}

const MINUTE_S = 60;

export const START_BY_ADDRESS: RateLimitRule = {
    name: "login-start:address",
    max: LOGIN_START_PER_ADDRESS_PER_MINUTE_MAX,
    windowS: MINUTE_S,
};
export const VERIFY_BY_ADDRESS: RateLimitRule = {
    name: "login-verify:address",
    max: LOGIN_VERIFY_PER_ADDRESS_PER_MINUTE_MAX,
    windowS: MINUTE_S,
};

export const PASSKEY_LOGIN_BY_ADDRESS: RateLimitRule = {
    name: "passkey-login:address",
    max: PASSKEY_LOGIN_PER_ADDRESS_PER_MINUTE_MAX,
    windowS: MINUTE_S,
};

export const OAUTH_BY_ADDRESS: RateLimitRule = {
    name: "oauth:address",
    max: OAUTH_PER_ADDRESS_PER_MINUTE_MAX,
    windowS: MINUTE_S,
};

// Keyed by "METHOD path". The provider segment of OAuth paths is folded to ":provider", so one
// limit covers GitHub and Google together.
const RULES: ReadonlyMap<string, RateLimitRule> = new Map([
    ["POST /api/v1/auth/email/start", START_BY_ADDRESS],
    ["POST /api/v1/invitations/accept", VERIFY_BY_ADDRESS],
    ["POST /api/v1/auth/email/verify", VERIFY_BY_ADDRESS],
    ["POST /api/v1/auth/passkey/login/options", PASSKEY_LOGIN_BY_ADDRESS],
    ["POST /api/v1/auth/passkey/login/verify", PASSKEY_LOGIN_BY_ADDRESS],
    ["POST /api/v1/auth/passkey/register/options", PASSKEY_LOGIN_BY_ADDRESS],
    ["POST /api/v1/auth/passkey/step-up/options", PASSKEY_LOGIN_BY_ADDRESS],
    ["POST /api/v1/auth/oauth/:provider/start", OAUTH_BY_ADDRESS],
    ["GET /api/v1/auth/oauth/:provider/callback", OAUTH_BY_ADDRESS],
]);

function ruleFor(method: string, path: string): RateLimitRule | undefined {
    const folded = path.replace(
        /^\/api\/v1\/auth\/oauth\/[a-z]+\//,
        "/api/v1/auth/oauth/:provider/",
    );
    return RULES.get(`${method} ${folded}`);
}

export function consumeRateLimit(
    deps: Pick<RateLimitDeps, "sql" | "clock" | "key">,
    rule: RateLimitRule,
    identifier: string,
): Promise<RateLimitVerdict> {
    return withRequestContext(
        deps.sql,
        { role: "aura_auth", actorKind: "anonymous", userId: null, orgIds: [] },
        (tx) =>
            checkRateLimit(
                { store: createPgCounterStore(tx), clock: deps.clock, key: deps.key },
                rule,
                identifier,
            ),
    );
}

export function refuseRateLimited(
    c: Parameters<typeof problemResponse>[0],
    verdict: RateLimitVerdict,
): Response {
    c.header("Retry-After", String(verdict.retryAfterS));
    return problemResponse(c, "rate_limited", "Too many requests");
}

export function rateLimit(deps: RateLimitDeps): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const rule = ruleFor(c.req.method, c.req.path);
        if (rule === undefined) return next();
        // No usable address means we cannot tell callers apart, so they share one strict bucket.
        const address = clientAddress(c, deps.trustEdge) ?? "unknown";
        const verdict = await consumeRateLimit(deps, rule, address);
        return verdict.allowed ? next() : refuseRateLimited(c, verdict);
    };
}
