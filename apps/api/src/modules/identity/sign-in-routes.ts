import {
    emailStartRequestSchema,
    emailStartResponseSchema,
    emailVerifyRequestSchema,
    emailVerifyResponseSchema,
} from "@aura/contracts/api/identity";
import { appendAudit } from "@aura/db/audit";
import type { Sql } from "@aura/db/client";
import { withRequestContext } from "@aura/db/context";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import { ipNetwork } from "../../platform/client-address.ts";
import type { Clock } from "../../platform/clock.ts";
import type { Logger } from "../../platform/log.ts";
import { type MailPort, MailUnavailableError } from "../../platform/mail.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { RateLimitRule } from "../../platform/rate-limit.ts";
import type { Rng } from "../../platform/rng.ts";
import { consumeRateLimit, refuseRateLimited } from "../../rate-limit-middleware.ts";
import { clientAddress, userAgentOf } from "../../request-info.ts";
import { LOGIN_CODE_ATTEMPTS_MAX, LOGIN_START_PER_EMAIL_PER_HOUR_MAX } from "./limits.ts";
import {
    parseLoginCookie,
    serializeClearedLoginCookie,
    serializeLoginCookie,
} from "./login-cookie.ts";
import { createPgChallengeStore, createPgSessionStore } from "./queries.ts";
import { serializeSessionCookie } from "./rules.ts";
import { checkProof, completeSignIn, type Proof, sendSignInEmail, startSignIn } from "./sign-in.ts";

export interface SignInRouteDeps {
    readonly sql: Sql;
    readonly clock: Clock;
    readonly rng: Rng;
    readonly logger: Logger;
    readonly mail: MailPort;
    readonly key: Buffer;
    readonly publicOrigin: string;
    readonly secureCookies: boolean;
    readonly trustEdge: boolean;
}

const START_BY_EMAIL: RateLimitRule = {
    name: "login-start:email",
    max: LOGIN_START_PER_EMAIL_PER_HOUR_MAX,
    windowS: 3600,
};
const IDENTITY_CONTEXT = {
    role: "aura_auth",
    actorKind: "anonymous",
    userId: null,
    orgIds: [],
} as const;

// Anonymous sign-in endpoints. They do not use the request transaction (that one acts as `aura_app`
// and rolls back on errors); each opens its own as `aura_auth`, so counted guesses and rate-limit
// counters survive a refused request.
export function signInRoutes(deps: SignInRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/auth/email/start", (c) => handleStart(c, deps));
    routes.post("/auth/email/verify", (c) => handleVerify(c, deps));
    return routes;
}

async function readJson(c: Context<AppEnv>): Promise<unknown> {
    return c.req.json().then(
        (body: unknown) => body,
        () => null,
    );
}

// The same answer whether the address has an account or not, so the endpoint cannot be used to
// find out who has one.
async function handleStart(c: Context<AppEnv>, deps: SignInRouteDeps): Promise<Response> {
    const parsed = emailStartRequestSchema.safeParse(await readJson(c));
    if (!parsed.success)
        return problemResponse(c, "invalid_request", "Enter a valid email address");
    const { email } = parsed.data;
    const verdict = await consumeRateLimit(deps, START_BY_EMAIL, email);
    if (!verdict.allowed) return refuseRateLimited(c, verdict);
    const challenge = await withRequestContext(deps.sql, IDENTITY_CONTEXT, (tx) =>
        startSignIn(
            {
                challenges: createPgChallengeStore(tx, LOGIN_CODE_ATTEMPTS_MAX),
                clock: deps.clock,
                rng: deps.rng,
                key: deps.key,
            },
            email,
        ),
    );
    try {
        await sendSignInEmail(deps.mail, deps.publicOrigin, email, challenge);
    } catch (error) {
        if (!(error instanceof MailUnavailableError)) throw error;
        deps.logger.error({ request_id: c.get("requestId"), err: error }, "sign-in email not sent");
        return problemResponse(c, "unavailable", "Could not send the email. Try again shortly");
    }
    c.header("Set-Cookie", serializeLoginCookie(challenge.binding, deps.secureCookies));
    return c.json(emailStartResponseSchema.parse({ status: "sent" }), 202);
}

const FAILED_TITLE = "That link or code did not work. Request a new one";

async function handleVerify(c: Context<AppEnv>, deps: SignInRouteDeps): Promise<Response> {
    const parsed = emailVerifyRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return problemResponse(c, "invalid_request", FAILED_TITLE);
    const binding = parseLoginCookie(c.req.header("cookie"), deps.secureCookies);
    if (binding === null) return problemResponse(c, "invalid_request", FAILED_TITLE);
    const outcome = await verifyInOwnTransaction(c, deps, binding, parsed.data);
    if (!outcome.ok) return problemResponse(c, "invalid_request", FAILED_TITLE);
    // authenticate may have queued a "clear the old session" cookie; the new session replaces it.
    c.set("clearSessionCookie", false);
    c.header("Set-Cookie", serializeSessionCookie(outcome.token, deps.secureCookies), {
        append: true,
    });
    c.header("Set-Cookie", serializeClearedLoginCookie(deps.secureCookies), { append: true });
    return c.json(
        emailVerifyResponseSchema.parse({ status: "signed_in", new_account: outcome.newAccount }),
    );
}

type Outcome = { ok: true; token: string; newAccount: boolean } | { ok: false };

function verifyInOwnTransaction(
    c: Context<AppEnv>,
    deps: SignInRouteDeps,
    binding: string,
    proof: Proof,
): Promise<Outcome> {
    const address = clientAddress(c, deps.trustEdge);
    const actor = c.get("actor");
    return withRequestContext(deps.sql, IDENTITY_CONTEXT, async (tx): Promise<Outcome> => {
        const sessions = { store: createPgSessionStore(tx), clock: deps.clock, rng: deps.rng };
        const checked = await checkProof(
            {
                challenges: createPgChallengeStore(tx, LOGIN_CODE_ATTEMPTS_MAX),
                key: deps.key,
                nowMs: deps.clock.nowUnixMs(),
            },
            binding,
            proof,
        );
        if (!checked.ok) {
            if (checked.locked) {
                await appendAudit(tx, {
                    actorKind: "anonymous",
                    actorUserId: null,
                    orgId: null,
                    action: "auth.code_locked",
                    ip: address,
                });
            }
            return { ok: false };
        }
        return completeSignIn(tx, sessions, {
            email: checked.email,
            method: checked.method,
            ipNetwork: address === null ? null : ipNetwork(address),
            ip: address,
            userAgent: userAgentOf(c),
            previousSessionId: actor.kind === "user" ? actor.sessionId : null,
        });
    });
}
