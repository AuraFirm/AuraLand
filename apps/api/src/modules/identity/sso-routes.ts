import {
    type SsoFailureReason,
    ssoStartRequestSchema,
    ssoStartResponseSchema,
} from "@aura/contracts/api/sso";
import type { Sql } from "@aura/db/client";
import { withRequestContext } from "@aura/db/context";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import { ipNetwork } from "../../platform/client-address.ts";
import type { Logger } from "../../platform/log.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { clientAddress, userAgentOf } from "../../request-info.ts";
import { parseFlowCookie, serializeClearedFlowCookie, serializeFlowCookie } from "./flow-cookie.ts";
import { createPgSessionStore } from "./queries.ts";
import { serializeSessionCookie } from "./rules.ts";
import {
    fetchAndVerify,
    recordSsoRefusal,
    resolveSso,
    type SsoDeps,
    spendSsoFlow,
    ssoRedirectUri,
    startSso,
} from "./sso-sign-in.ts";

export interface SsoRouteDeps extends SsoDeps {
    readonly sql: Sql;
    readonly logger: Logger;
    readonly secureCookies: boolean;
    readonly trustEdge: boolean;
}

const IDENTITY_CONTEXT = {
    role: "aura_auth",
    actorKind: "anonymous",
    userId: null,
    orgIds: [],
} as const;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[A-Za-z0-9._~/+=-]{1,2048}$/;

// Signing in through an organization's identity provider. Like the other sign-in routes, `start` and `callback` run their own
// `aura_auth` transactions, so a refusal is still recorded. Per-address limits come from the rate limit on all of /v1.
export function ssoSignInRoutes(deps: SsoRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/auth/sso/start", (c) => handleStart(c, deps));
    routes.get("/auth/sso/callback", (c) => handleCallback(c, deps));
    return routes;
}

async function handleStart(c: Context<AppEnv>, deps: SsoRouteDeps) {
    const body = ssoStartRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return problemResponse(c, "invalid_request", "Enter a valid email address");
    const started = await withRequestContext(deps.sql, IDENTITY_CONTEXT, (tx) =>
        startSso(tx, deps, body.data.email.toLowerCase()),
    );
    // Domains and connections are not secrets (a person is sent to the provider either way), but a miss is a plain 404.
    if (started === null)
        return problemResponse(c, "not_found", "Single sign-on is not set up for this address");
    c.header("Set-Cookie", serializeFlowCookie(started.verifier, deps.secureCookies));
    return c.json(ssoStartResponseSchema.parse({ authorization_url: started.authorizationUrl }));
}

type Outcome =
    | { readonly status: "signed_in"; readonly token: string }
    | { readonly status: "failed"; readonly reason: SsoFailureReason };
const failed = (reason: SsoFailureReason): Outcome => ({ status: "failed", reason });

async function handleCallback(c: Context<AppEnv>, deps: SsoRouteDeps) {
    const outcome = await runCallback(c, deps);
    c.set("clearSessionCookie", false);
    c.header("Set-Cookie", serializeClearedFlowCookie(deps.secureCookies));
    if (outcome.status === "signed_in")
        c.header("Set-Cookie", serializeSessionCookie(outcome.token, deps.secureCookies), {
            append: true,
        });
    const target = new URL("/auth/done", deps.publicOrigin);
    target.searchParams.set("status", outcome.status);
    if (outcome.status === "failed") target.searchParams.set("reason", outcome.reason);
    return c.redirect(target.toString(), 302);
}

async function runCallback(c: Context<AppEnv>, deps: SsoRouteDeps): Promise<Outcome> {
    if (c.req.query("error") !== undefined) return failed("denied");
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const verifier = parseFlowCookie(c.req.header("cookie"), deps.secureCookies);
    if (verifier === null || !STATE_PATTERN.test(state) || !CODE_PATTERN.test(code))
        return failed("invalid");
    const flow = await withRequestContext(deps.sql, IDENTITY_CONTEXT, (tx) =>
        spendSsoFlow(tx, deps, { state, verifier }),
    );
    if (flow === null) return failed("invalid");
    // The provider is called between the two transactions, so none is held open for the network.
    const checked = await fetchAndVerify(deps, flow, {
        code,
        verifier,
        redirectUri: ssoRedirectUri(deps.publicOrigin),
    }).catch((error: unknown) => {
        deps.logger.error(
            { request_id: c.get("requestId"), err: error },
            "single sign-on provider failed",
        );
        return "unavailable" as const;
    });
    if (checked === "unavailable") return failed("unavailable");
    if (!checked.ok) {
        await withRequestContext(deps.sql, IDENTITY_CONTEXT, (tx) =>
            recordSsoRefusal(tx, flow.org, checked.reason, clientAddress(c, deps.trustEdge)),
        );
        return failed(checked.reason === "email_unverified" ? "email_unverified" : "invalid");
    }
    return finish(c, deps, flow.org, checked);
}

function finish(
    c: Context<AppEnv>,
    deps: SsoRouteDeps,
    org: string,
    profile: { subject: string; email: string },
): Promise<Outcome> {
    const address = clientAddress(c, deps.trustEdge);
    const actor = c.get("actor");
    return withRequestContext(deps.sql, IDENTITY_CONTEXT, async (tx): Promise<Outcome> => {
        const sessions = { store: createPgSessionStore(tx), clock: deps.clock, rng: deps.rng };
        const resolved = await resolveSso(tx, deps, sessions, {
            org,
            subject: profile.subject,
            email: profile.email,
            session: {
                ipNetwork: address === null ? null : ipNetwork(address),
                ip: address,
                userAgent: userAgentOf(c),
                previousSessionId: actor.kind === "user" ? actor.sessionId : null,
            },
        });
        if (resolved.kind === "signed_in") return { status: "signed_in", token: resolved.token };
        await recordSsoRefusal(tx, org, resolved.reason, address);
        return failed(resolved.reason);
    });
}
