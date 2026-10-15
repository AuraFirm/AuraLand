import {
    grantSupportRequestSchema,
    supportGrantSchema,
    supportGrantsResponseSchema,
    supportOverviewSchema,
} from "@aura/contracts/api/support";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { hasFreshStepUp } from "../../platform/step-up.ts";

export interface SupportRouteDeps {
    readonly clock: Clock;
}

const NO_DATA_FOUND = "P0002";
const INSUFFICIENT_PRIVILEGE = "42501";

// Consented support access (Stage 9, slice 10). A person makes a grant (fresh passkey check), sees every look and ends it when they
// like; a platform administrator can read the summary only while a grant is live. It never lets staff act as the person.
export function supportRoutes(deps: SupportRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/me/support-access", (c) => handleGrant(c, deps));
    routes.get("/me/support-access", (c) => handleList(c, deps));
    routes.delete("/me/support-access", (c) => handleRevoke(c, deps));
    routes.get("/admin/support/users/:id", (c) => handleOverview(c, deps));
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");

function person(c: Context<AppEnv>, deps: SupportRouteDeps, change: boolean) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return { problem: problemResponse(c, "unauthenticated", "Authentication required") };
    if (change && !hasFreshStepUp(actor.stepUpAtMs, deps.clock.nowUnixMs()))
        return {
            problem: problemResponse(
                c,
                "step_up_required",
                "Confirm with your passkey to continue",
            ),
        };
    return { actor };
}

async function handleGrant(c: Context<AppEnv>, deps: SupportRouteDeps) {
    const who = person(c, deps, true);
    if ("problem" in who) return who.problem;
    const body = grantSupportRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return problemResponse(c, "invalid_request", "Invalid request");
    const tx = c.get("tx");
    const [row] =
        await tx`select grant_support_access(${body.data.hours}, ${new Date(deps.clock.nowUnixMs())}) as id`;
    const id = z.object({ id: z.string() }).parse(row).id;
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: who.actor.userId,
        orgId: null,
        action: "support.access_granted",
        target: encodeId("sgr", id),
        detail: { hours: body.data.hours },
    });
    return c.json(await grants(c), 201);
}

const grantRow = z.object({
    id: z.string(),
    created_at: z.date(),
    expires_at: z.date(),
    revoked_at: z.date().nullable(),
});
const viewRow = z.object({ grant_id: z.string(), admin_id: z.string(), viewed_at: z.date() });

async function grants(c: Context<AppEnv>) {
    const tx = c.get("tx");
    const rows = (
        await tx`select id, created_at, expires_at, revoked_at from support_grants order by id desc limit 20`
    ).map((r) => grantRow.parse(r));
    const views = (
        await tx`select grant_id, admin_id, viewed_at from support_views order by id desc limit 200`
    ).map((r) => viewRow.parse(r));
    return supportGrantsResponseSchema.parse({
        grants: rows.map((g) =>
            supportGrantSchema.parse({
                id: encodeId("sgr", g.id),
                created_at: g.created_at.toISOString(),
                expires_at: g.expires_at.toISOString(),
                revoked: g.revoked_at !== null,
                views: views
                    .filter((v) => v.grant_id === g.id)
                    .map((v) => ({
                        viewed_at: v.viewed_at.toISOString(),
                        admin_id: encodeId("usr", v.admin_id),
                    })),
            }),
        ),
    });
}

async function handleList(c: Context<AppEnv>, deps: SupportRouteDeps) {
    const who = person(c, deps, false);
    if ("problem" in who) return who.problem;
    return c.json(await grants(c));
}

async function handleRevoke(c: Context<AppEnv>, deps: SupportRouteDeps) {
    const who = person(c, deps, false);
    if ("problem" in who) return who.problem;
    const tx = c.get("tx");
    await tx`select revoke_support_access(${new Date(deps.clock.nowUnixMs())})`;
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: who.actor.userId,
        orgId: null,
        action: "support.access_revoked",
        detail: {},
    });
    return c.body(null, 204);
}

// The look and its record happen in one database call; the audit row is in the same transaction, so a failure of either leaves neither.
async function handleOverview(c: Context<AppEnv>, deps: SupportRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind === "anonymous")
        return problemResponse(c, "unauthenticated", "Authentication required");
    if (actor.kind !== "user" || actor.platformRole !== "admin") return notFound(c);
    const target = idSchema("usr").safeParse(c.req.param("id"));
    if (!target.success) return problemResponse(c, "invalid_request", "Invalid request");
    const tx = c.get("tx");
    try {
        const [row] =
            await tx`select support_overview(${decodeId("usr", target.data)}, ${new Date(deps.clock.nowUnixMs())}) as overview`;
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: actor.userId,
            orgId: null,
            action: "support.account_viewed",
            target: target.data,
            detail: {},
        });
        c.header("Cache-Control", "no-store");
        return c.json(
            supportOverviewSchema.parse(z.object({ overview: z.unknown() }).parse(row).overview),
        );
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND || code === INSUFFICIENT_PRIVILEGE) return notFound(c);
        throw error;
    }
}
