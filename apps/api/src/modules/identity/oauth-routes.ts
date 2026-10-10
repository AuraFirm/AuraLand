import {
    identitiesResponseSchema,
    identitySchema,
    type OAuthFailureReason,
    oauthProviderSchema,
    oauthStartRequestSchema,
    oauthStartResponseSchema,
} from "@aura/contracts/api/oauth";
import type { Sql } from "@aura/db/client";
import { withRequestContext } from "@aura/db/context";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import { ipNetwork } from "../../platform/client-address.ts";
import type { Logger } from "../../platform/log.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { clientAddress, userAgentOf } from "../../request-info.ts";
import { hasFreshStepUp } from "./authorize.ts";
import { parseFlowCookie, serializeClearedFlowCookie, serializeFlowCookie } from "./flow-cookie.ts";
import {
    type OAuthDeps,
    type RefusalReason,
    recordRefusal,
    redirectUriFor,
    resolveSignIn,
    spendFlow,
    startOAuth,
    unlinkAudit,
} from "./oauth.ts";
import { type OAuthProvider, OAuthUnavailableError, type ProviderName } from "./oauth-providers.ts";
import { deleteOwnIdentity, listOwnIdentities } from "./oauth-queries.ts";
import { listOwnPasskeys } from "./passkey-queries.ts";
import { createPgSessionStore } from "./queries.ts";
import { serializeSessionCookie } from "./rules.ts";

export interface OAuthRouteDeps extends OAuthDeps {
    readonly sql: Sql;
    readonly logger: Logger;
    readonly providers: ReadonlyMap<ProviderName, OAuthProvider>;
    readonly secureCookies: boolean;
    readonly trustEdge: boolean;
}

const IDENTITY_CONTEXT = {
    role: "aura_auth",
    actorKind: "anonymous",
    userId: null,
    orgIds: [],
} as const;

// OAuth sign-in with GitHub and Google. `start` and `callback` run their own `aura_auth` transactions
// (see sign-in-routes.ts); the identity list and unlink routes use the request transaction.
export function oauthRoutes(deps: OAuthRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/auth/oauth/:provider/start", (c) => handleStart(c, deps));
    routes.get("/auth/oauth/:provider/callback", (c) => handleCallback(c, deps));
    routes.get("/me/identities", handleList);
    routes.delete("/me/identities/:provider", (c) => handleUnlink(c, deps));
    return routes;
}

function providerFor(c: Context<AppEnv>, deps: OAuthRouteDeps): OAuthProvider | null {
    const name = oauthProviderSchema.safeParse(c.req.param("provider"));
    return name.success ? (deps.providers.get(name.data) ?? null) : null;
}

const readJson = (c: Context<AppEnv>): Promise<unknown> =>
    c.req.json().then(
        (body: unknown) => body,
        () => ({}),
    );

async function handleStart(c: Context<AppEnv>, deps: OAuthRouteDeps) {
    const provider = providerFor(c, deps);
    if (provider === null) return problemResponse(c, "not_found", "Not found");
    const body = oauthStartRequestSchema.safeParse(await readJson(c));
    if (!body.success) return problemResponse(c, "invalid_request", "Invalid request");
    const actor = c.get("actor");
    const userId = actor.kind === "user" ? actor.userId : null;
    if (body.data.purpose === "link" && userId === null) {
        return problemResponse(c, "unauthenticated", "Sign in first to connect an account");
    }
    const started = await withRequestContext(deps.sql, IDENTITY_CONTEXT, (tx) =>
        startOAuth(tx, deps, provider, {
            purpose: body.data.purpose,
            userId: body.data.purpose === "link" ? userId : null,
        }),
    );
    c.header("Set-Cookie", serializeFlowCookie(started.verifier, deps.secureCookies));
    return c.json(oauthStartResponseSchema.parse({ authorization_url: started.authorizationUrl }));
}

const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[A-Za-z0-9._~/+=-]{1,2048}$/;

type CallbackOutcome =
    | { readonly status: "signed_in"; readonly token: string }
    | { readonly status: "linked" }
    | { readonly status: "failed"; readonly reason: OAuthFailureReason };

const failed = (reason: OAuthFailureReason): CallbackOutcome => ({ status: "failed", reason });

async function handleCallback(c: Context<AppEnv>, deps: OAuthRouteDeps) {
    const provider = providerFor(c, deps);
    if (provider === null) return problemResponse(c, "not_found", "Not found");
    const outcome = await runCallback(c, deps, provider);
    c.set("clearSessionCookie", false);
    c.header("Set-Cookie", serializeClearedFlowCookie(deps.secureCookies));
    if (outcome.status === "signed_in") {
        c.header("Set-Cookie", serializeSessionCookie(outcome.token, deps.secureCookies), {
            append: true,
        });
    }
    const target = new URL("/auth/done", deps.publicOrigin);
    target.searchParams.set("status", outcome.status);
    if (outcome.status === "failed") target.searchParams.set("reason", outcome.reason);
    return c.redirect(target.toString(), 302);
}

async function runCallback(
    c: Context<AppEnv>,
    deps: OAuthRouteDeps,
    provider: OAuthProvider,
): Promise<CallbackOutcome> {
    if (c.req.query("error") !== undefined) return failed("denied");
    const state = c.req.query("state") ?? "";
    const code = c.req.query("code") ?? "";
    const verifier = parseFlowCookie(c.req.header("cookie"), deps.secureCookies);
    if (verifier === null || !STATE_PATTERN.test(state) || !CODE_PATTERN.test(code)) {
        return failed("invalid");
    }
    const flow = await withRequestContext(deps.sql, IDENTITY_CONTEXT, (tx) =>
        spendFlow(tx, deps, provider.name, { state, verifier }),
    );
    if (flow === null) return failed("invalid");
    // The provider call happens between the two transactions, so none is held open for the network.
    const exchanged = await provider
        .exchange({
            code,
            codeVerifier: verifier,
            redirectUri: redirectUriFor(deps.publicOrigin, provider.name),
        })
        .catch((error: unknown) => {
            if (!(error instanceof OAuthUnavailableError)) throw error;
            deps.logger.error(
                { request_id: c.get("requestId"), err: error },
                "oauth provider failed",
            );
            return null;
        });
    if (exchanged === null) return failed("unavailable");
    if (!exchanged.ok) return failed("invalid");
    return finishCallback(c, deps, provider.name, flow, exchanged.profile);
}

function finishCallback(
    c: Context<AppEnv>,
    deps: OAuthRouteDeps,
    provider: ProviderName,
    flow: { purpose: "login" | "link"; userId: string | null },
    profile: { providerUserId: string; verifiedEmail: string | null },
): Promise<CallbackOutcome> {
    const address = clientAddress(c, deps.trustEdge);
    const actor = c.get("actor");
    return withRequestContext(deps.sql, IDENTITY_CONTEXT, async (tx): Promise<CallbackOutcome> => {
        const sessions = { store: createPgSessionStore(tx), clock: deps.clock, rng: deps.rng };
        const resolved = await resolveSignIn(tx, deps, sessions, {
            provider,
            profile,
            flow,
            currentUserId: actor.kind === "user" ? actor.userId : null,
            session: {
                ipNetwork: address === null ? null : ipNetwork(address),
                ip: address,
                userAgent: userAgentOf(c),
                previousSessionId: actor.kind === "user" ? actor.sessionId : null,
            },
        });
        if (resolved.kind === "signed_in") return { status: "signed_in", token: resolved.token };
        if (resolved.kind === "linked") return { status: "linked" };
        await recordRefusal(tx, provider, resolved.reason, address);
        return failed(failureFor(resolved.reason));
    });
}

function failureFor(reason: RefusalReason): OAuthFailureReason {
    return reason;
}

async function handleList(c: Context<AppEnv>) {
    if (c.get("actor").kind !== "user") {
        return problemResponse(c, "unauthenticated", "Authentication required");
    }
    const rows = await listOwnIdentities(c.get("tx"));
    const items = rows.map((row) =>
        identitySchema.parse({
            provider: row.provider,
            email: row.email_at_link,
            created_at: row.created_at.toISOString(),
            last_login_at: row.last_login_at === null ? null : row.last_login_at.toISOString(),
        }),
    );
    return c.json(identitiesResponseSchema.parse({ items }));
}

// Disconnecting a sign-in method changes how the person proves who they are (ASVS V7.5.1). Anyone
// who holds a passkey must prove it again first; someone with no passkey has nothing stronger to show.
async function handleUnlink(c: Context<AppEnv>, deps: OAuthRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const provider = oauthProviderSchema.safeParse(c.req.param("provider"));
    if (!provider.success) return problemResponse(c, "invalid_request", "Unknown provider");
    const tx = c.get("tx");
    const holdsPasskey = (await listOwnPasskeys(tx)).length > 0;
    if (holdsPasskey && !hasFreshStepUp(actor.stepUpAtMs, deps.clock.nowUnixMs())) {
        return problemResponse(c, "step_up_required", "Confirm with your passkey to continue");
    }
    if (!(await deleteOwnIdentity(tx, provider.data)))
        return problemResponse(c, "not_found", "Not found");
    await unlinkAudit(tx, actor.userId, provider.data);
    return c.body(null, 204);
}
