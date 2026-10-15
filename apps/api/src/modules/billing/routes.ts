import {
    checkoutRequestSchema,
    entitlementsSchema,
    planChangedSchema,
    sessionUrlSchema,
    setPlanRequestSchema,
    usageResponseSchema,
} from "@aura/contracts/api/billing";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { hasFreshStepUp } from "../../platform/step-up.ts";
import type { PaymentProvider } from "./provider.ts";
import * as q from "./queries.ts";
import { monthBoundsUtc } from "./rules.ts";

export interface BillingRouteDeps {
    readonly clock: Clock;
    readonly publicOrigin: string;
    // Undefined means no payment provider is configured: buying and the portal answer "unavailable".
    readonly provider: PaymentProvider | undefined;
}

const INSUFFICIENT_PRIVILEGE = "42501";
const NO_DATA_FOUND = "P0002";

// Plans (Stage 9, slice 1). Members read their organization's entitlements; only a platform administrator, freshly confirmed
// with a passkey, changes a plan. Everyone else gets the 404 they would get for a route that does not exist.
export function billingRoutes(deps: BillingRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/orgs/:id/plan", handleRead);
    routes.get("/orgs/:id/usage", (c) => handleUsage(c, deps));
    routes.put("/admin/orgs/:id/plan", (c) => handleSet(c, deps));
    routes.post("/orgs/:id/billing/checkout", (c) => handleCheckout(c, deps));
    routes.post("/orgs/:id/billing/portal", (c) => handlePortal(c, deps));
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");

async function handleRead(c: Context<AppEnv>) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const org = idSchema("org").safeParse(c.req.param("id"));
    if (!org.success) return problemResponse(c, "invalid_request", "Invalid request");
    const entitlements = await q.entitlementsOf(c.get("tx"), decodeId("org", org.data));
    return entitlements === null ? notFound(c) : c.json(entitlementsSchema.parse(entitlements));
}

async function handleSet(c: Context<AppEnv>, deps: BillingRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind === "anonymous")
        return problemResponse(c, "unauthenticated", "Authentication required");
    if (actor.kind !== "user" || actor.platformRole !== "admin") return notFound(c);
    if (!hasFreshStepUp(actor.stepUpAtMs, deps.clock.nowUnixMs()))
        return problemResponse(c, "step_up_required", "Confirm with your passkey to continue");
    const org = idSchema("org").safeParse(c.req.param("id"));
    const body = setPlanRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!org.success || !body.success)
        return problemResponse(c, "invalid_request", "Invalid request");
    const orgId = decodeId("org", org.data);
    const tx = c.get("tx");
    try {
        await q.setPlan(tx, {
            org: orgId,
            plan: body.data.plan,
            billingRef: body.data.billing_ref,
            contractRef: body.data.contract_ref,
            nowMs: deps.clock.nowUnixMs(),
        });
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND || code === INSUFFICIENT_PRIVILEGE) return notFound(c);
        throw error;
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: null,
        action: "billing.plan_set",
        target: encodeId("org", orgId),
        detail: { plan: body.data.plan },
    });
    // The administrator is not necessarily a member of the organization, so read the plan back from the table.
    const [row] =
        await tx`select p.key as plan, p.name, p.members_max, p.env_runs_per_month, p.verifications_per_month,
        p.webhook_endpoints_max, p.sso, p.scim, p.employer_search from plans p where p.key = ${body.data.plan}`;
    return c.json(
        planChangedSchema.parse({
            org_id: encodeId("org", orgId),
            entitlements: entitlementsSchema.parse(row),
        }),
    );
}

async function handleUsage(c: Context<AppEnv>, deps: BillingRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const org = idSchema("org").safeParse(c.req.param("id"));
    if (!org.success) return problemResponse(c, "invalid_request", "Invalid request");
    const orgId = decodeId("org", org.data);
    const { startMs, endMs } = monthBoundsUtc(deps.clock.nowUnixMs());
    const tx = c.get("tx");
    const [entitlements, usage] = [
        await q.entitlementsOf(tx, orgId),
        await q.usageOf(tx, orgId, startMs, endMs),
    ];
    if (entitlements === null || usage === null) return notFound(c);
    return c.json(
        usageResponseSchema.parse({
            period_start: new Date(startMs).toISOString(),
            period_end: new Date(endMs).toISOString(),
            env_runs: usage.env_run,
            employer_reports: usage.employer_report,
            env_runs_limit: entitlements.env_runs_per_month,
        }),
    );
}

// Buying and managing a subscription are the organization's owners' and administrators' acts, behind a fresh passkey check
// because they change what the organization pays. A stranger gets 404, an ordinary member 403.
async function billingActor(c: Context<AppEnv>, deps: BillingRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return { problem: problemResponse(c, "unauthenticated", "Authentication required") };
    const org = idSchema("org").safeParse(c.req.param("id"));
    if (!org.success) return { problem: problemResponse(c, "invalid_request", "Invalid request") };
    const orgId = decodeId("org", org.data);
    const role = await q.roleOf(c.get("tx"), orgId);
    if (role === null) return { problem: notFound(c) };
    if (role !== "owner" && role !== "admin")
        return { problem: problemResponse(c, "forbidden", "Forbidden") };
    if (!hasFreshStepUp(actor.stepUpAtMs, deps.clock.nowUnixMs()))
        return {
            problem: problemResponse(
                c,
                "step_up_required",
                "Confirm with your passkey to continue",
            ),
        };
    if (deps.provider === undefined)
        return { problem: problemResponse(c, "unavailable", "Billing is not available") };
    return { actor, orgId, orgPublicId: encodeId("org", orgId), provider: deps.provider };
}

async function handleCheckout(c: Context<AppEnv>, deps: BillingRouteDeps) {
    const who = await billingActor(c, deps);
    if ("problem" in who) return who.problem;
    const body = checkoutRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return problemResponse(c, "invalid_request", "Invalid request");
    const tx = c.get("tx");
    const current = await q.entitlementsOf(tx, who.orgId);
    if (current?.plan === body.data.plan)
        return problemResponse(
            c,
            "conflict",
            "Conflict",
            "the organization is already on this plan",
        );
    const page = `${deps.publicOrigin}/orgs/${who.orgPublicId}/billing`;
    const session = await who.provider.createCheckoutSession({
        orgPublicId: who.orgPublicId,
        plan: body.data.plan,
        successUrl: `${page}?checkout=success`,
        cancelUrl: `${page}?checkout=cancelled`,
    });
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: who.actor.userId,
        orgId: null,
        action: "billing.checkout_started",
        target: who.orgPublicId,
        detail: { plan: body.data.plan },
    });
    c.header("Cache-Control", "no-store");
    return c.json(sessionUrlSchema.parse({ url: session.url }), 201);
}

async function handlePortal(c: Context<AppEnv>, deps: BillingRouteDeps) {
    const who = await billingActor(c, deps);
    if ("problem" in who) return who.problem;
    const tx = c.get("tx");
    const billingRef = await q.billingRefOf(tx, who.orgId);
    if (billingRef === null) return notFound(c); // nothing has been bought yet
    const session = await who.provider.createPortalSession({
        billingRef,
        returnUrl: `${deps.publicOrigin}/orgs/${who.orgPublicId}/billing`,
    });
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: who.actor.userId,
        orgId: null,
        action: "billing.portal_opened",
        target: who.orgPublicId,
        detail: {},
    });
    c.header("Cache-Control", "no-store");
    return c.json(sessionUrlSchema.parse({ url: session.url }), 201);
}
