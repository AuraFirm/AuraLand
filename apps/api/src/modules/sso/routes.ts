import {
    addSsoDomainRequestSchema,
    domainSchema,
    saveSsoConnectionRequestSchema,
    ssoConnectionSchema,
    ssoDomainSchema,
    ssoDomainsResponseSchema,
    ssoEnforcementRequestSchema,
} from "@aura/contracts/api/sso";
import { decodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import type { TxtResolver } from "../../platform/dns-txt.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { Rng } from "../../platform/rng.ts";
import { hasFreshStepUp } from "../../platform/step-up.ts";
import { roleOf } from "../billing/service.ts";
import type { OidcTransport } from "./oidc.ts";
import * as q from "./queries.ts";

export interface SsoRouteDeps {
    readonly clock: Clock;
    readonly rng: Rng;
    readonly oidc: OidcTransport;
    readonly dns: TxtResolver;
}

const NO_DATA_FOUND = "P0002";
const FEATURE_NOT_SUPPORTED = "0A000";
const PROGRAM_LIMIT_EXCEEDED = "54000";
const UNIQUE_VIOLATION = "23505";
const OBJECT_NOT_IN_STATE = "55000";
const DOMAIN_TOKEN_BYTES = 16;

// Single sign-on administration (Stage 9, slice 6a): the owners and administrators of an organization on a plan that includes it
// connect an OpenID Connect provider and prove they control their email domains. Saving a connection and verifying a domain need a
// fresh passkey check. A stranger gets 404, an ordinary member 403.
export function ssoRoutes(deps: SsoRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.put("/orgs/:id/sso", (c) => handleSave(c, deps));
    routes.get("/orgs/:id/sso", (c) => handleRead(c, deps));
    routes.delete("/orgs/:id/sso", (c) => handleDelete(c, deps));
    routes.put("/orgs/:id/sso/enforcement", (c) => handleEnforce(c, deps));
    routes.post("/orgs/:id/sso/domains", (c) => handleAddDomain(c, deps));
    routes.get("/orgs/:id/sso/domains", (c) => handleListDomains(c, deps));
    routes.post("/orgs/:id/sso/domains/:domain/verify", (c) => handleVerify(c, deps));
    routes.delete("/orgs/:id/sso/domains/:domain", (c) => handleRemoveDomain(c, deps));
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");
const invalid = (c: Context<AppEnv>, detail?: string) =>
    problemResponse(c, "invalid_request", "Invalid request", detail);

// Who may administer this organization's sign-in: a person with the role, and for changes a fresh passkey check.
async function administrator(c: Context<AppEnv>, deps: SsoRouteDeps, change: boolean) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return { problem: problemResponse(c, "unauthenticated", "Authentication required") };
    const org = idSchema("org").safeParse(c.req.param("id"));
    if (!org.success) return { problem: invalid(c) };
    const orgId = decodeId("org", org.data);
    const role = await roleOf(c.get("tx"), orgId);
    if (role === null) return { problem: notFound(c) };
    if (role !== "owner" && role !== "admin")
        return { problem: problemResponse(c, "forbidden", "Forbidden") };
    if (change && !hasFreshStepUp(actor.stepUpAtMs, deps.clock.nowUnixMs()))
        return {
            problem: problemResponse(
                c,
                "step_up_required",
                "Confirm with your passkey to continue",
            ),
        };
    return { actor, orgId, orgPublicId: org.data };
}

function translated(c: Context<AppEnv>, error: unknown) {
    const code = postgresErrorCode(error);
    if (code === NO_DATA_FOUND) return notFound(c);
    if (code === FEATURE_NOT_SUPPORTED)
        return problemResponse(
            c,
            "plan_limit_reached",
            "Plan limit reached",
            "this plan does not include single sign-on",
        );
    if (code === PROGRAM_LIMIT_EXCEEDED) return invalid(c, "too many domains");
    if (code === OBJECT_NOT_IN_STATE)
        return problemResponse(
            c,
            "conflict",
            "Conflict",
            "verify a domain and sign in through single sign-on yourself first",
        );
    if (code === UNIQUE_VIOLATION)
        return problemResponse(
            c,
            "conflict",
            "Conflict",
            "another organization has already verified this domain",
        );
    throw error;
}

async function handleSave(c: Context<AppEnv>, deps: SsoRouteDeps) {
    const who = await administrator(c, deps, true);
    if ("problem" in who) return who.problem;
    const body = saveSsoConnectionRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    // The provider must describe itself as exactly the issuer typed, with addresses we are willing to call; this also proves the
    // address is reachable before anything is saved.
    const discovery = await deps.oidc.discover(body.data.issuer);
    if (discovery === null)
        return invalid(
            c,
            "the provider could not be reached or does not describe itself as this issuer",
        );
    const tx = c.get("tx");
    try {
        await q.saveConnection(tx, {
            org: who.orgId,
            issuer: body.data.issuer,
            clientId: body.data.client_id,
            clientSecret: body.data.client_secret,
            discovery,
            nowMs: deps.clock.nowUnixMs(),
        });
    } catch (error) {
        return translated(c, error);
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: who.actor.userId,
        orgId: null,
        action: "sso.connection_saved",
        target: who.orgPublicId,
        detail: { issuer: body.data.issuer },
    });
    c.header("Cache-Control", "no-store");
    return c.json(ssoConnectionSchema.parse(await q.getConnection(tx, who.orgId)));
}

async function handleRead(c: Context<AppEnv>, deps: SsoRouteDeps) {
    const who = await administrator(c, deps, false);
    if ("problem" in who) return who.problem;
    const connection = await q.getConnection(c.get("tx"), who.orgId);
    return connection === null ? notFound(c) : c.json(connection);
}

async function handleDelete(c: Context<AppEnv>, deps: SsoRouteDeps) {
    const who = await administrator(c, deps, true);
    if ("problem" in who) return who.problem;
    const tx = c.get("tx");
    try {
        await q.deleteConnection(tx, who.orgId);
    } catch (error) {
        return translated(c, error);
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: who.actor.userId,
        orgId: null,
        action: "sso.connection_deleted",
        target: who.orgPublicId,
        detail: {},
    });
    return c.body(null, 204);
}

async function handleAddDomain(c: Context<AppEnv>, deps: SsoRouteDeps) {
    const who = await administrator(c, deps, false);
    if ("problem" in who) return who.problem;
    const body = addSsoDomainRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const tx = c.get("tx");
    try {
        const token = await q.addDomain(
            tx,
            who.orgId,
            body.data.domain,
            Buffer.from(deps.rng.nextBytes(DOMAIN_TOKEN_BYTES)).toString("hex"),
            deps.clock.nowUnixMs(),
        );
        return c.json(
            ssoDomainSchema.parse({
                domain: body.data.domain,
                txt_name: q.challengeName(body.data.domain),
                txt_value: q.challengeValue(token),
                verified: false,
            }),
            201,
        );
    } catch (error) {
        return translated(c, error);
    }
}

async function handleListDomains(c: Context<AppEnv>, deps: SsoRouteDeps) {
    const who = await administrator(c, deps, false);
    if ("problem" in who) return who.problem;
    return c.json(
        ssoDomainsResponseSchema.parse({ domains: await q.listDomains(c.get("tx"), who.orgId) }),
    );
}

async function handleVerify(c: Context<AppEnv>, deps: SsoRouteDeps) {
    const who = await administrator(c, deps, true);
    if ("problem" in who) return who.problem;
    const domain = domainSchema.safeParse(c.req.param("domain"));
    if (!domain.success) return invalid(c);
    const tx = c.get("tx");
    const token = await q.domainToken(tx, who.orgId, domain.data);
    if (token === null) return notFound(c);
    const published = await deps.dns.resolveTxt(q.challengeName(domain.data));
    if (!published.includes(q.challengeValue(token)))
        return problemResponse(c, "conflict", "Conflict", "the DNS record was not found yet");
    try {
        await q.markVerified(tx, who.orgId, domain.data, deps.clock.nowUnixMs());
    } catch (error) {
        return translated(c, error);
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: who.actor.userId,
        orgId: null,
        action: "sso.domain_verified",
        target: who.orgPublicId,
        detail: { domain: domain.data },
    });
    return c.json(ssoDomainsResponseSchema.parse({ domains: await q.listDomains(tx, who.orgId) }));
}

async function handleRemoveDomain(c: Context<AppEnv>, deps: SsoRouteDeps) {
    const who = await administrator(c, deps, true);
    if ("problem" in who) return who.problem;
    const domain = domainSchema.safeParse(c.req.param("domain"));
    if (!domain.success) return invalid(c);
    try {
        await q.removeDomain(c.get("tx"), who.orgId, domain.data);
    } catch (error) {
        return translated(c, error);
    }
    return c.body(null, 204);
}

// Requiring SSO locks out everyone but owners who use anything else, so it needs a verified domain and an administrator who has
// already signed in through SSO themselves (the database checks both).
async function handleEnforce(c: Context<AppEnv>, deps: SsoRouteDeps) {
    const who = await administrator(c, deps, true);
    if ("problem" in who) return who.problem;
    const body = ssoEnforcementRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const tx = c.get("tx");
    try {
        await q.setEnforced(tx, who.orgId, body.data.enforced);
    } catch (error) {
        return translated(c, error);
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: who.actor.userId,
        orgId: null,
        action: body.data.enforced ? "sso.enforced" : "sso.enforcement_removed",
        target: who.orgPublicId,
        detail: {},
    });
    return c.json(ssoConnectionSchema.parse(await q.getConnection(tx, who.orgId)));
}
