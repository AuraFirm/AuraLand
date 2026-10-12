import {
    payoutCreateRequestSchema,
    payoutPaidRequestSchema,
    payoutSchema,
    payoutsResponseSchema,
} from "@aura/contracts/api/payouts";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { ORDER_PAGE_SIZE_MAX } from "@aura/contracts/limits";
import { appendAudit } from "@aura/db/audit";
import { postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { hasFreshStepUp } from "../../platform/step-up.ts";
import { getPayout, listPayouts, markPayoutPaid, type PayoutRow, recordPayout } from "./queries.ts";

export interface PayoutRouteDeps {
    readonly clock: Clock;
}

const INSUFFICIENT_PRIVILEGE = "42501";
const NO_DATA_FOUND = "P0002";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";

// Platform administrators record agreements and payments; a contractor lists their own.
export function payoutRoutes(deps: PayoutRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/admin/payouts", (c) => adminWrite(c, deps, handleCreate));
    routes.get("/admin/payouts", (c) => adminRead(c, handleAdminList));
    routes.post("/admin/payouts/:id/paid", (c) => adminWrite(c, deps, handlePaid));
    routes.get("/me/payouts", handleMine);
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");

function administrator(c: Context<AppEnv>): { userId: string } | Response {
    const actor = c.get("actor");
    if (actor.kind === "anonymous")
        return problemResponse(c, "unauthenticated", "Authentication required");
    if (actor.kind !== "user" || actor.platformRole !== "admin") return notFound(c);
    return { userId: actor.userId };
}

async function adminRead(c: Context<AppEnv>, handler: (c: Context<AppEnv>) => Promise<Response>) {
    const admin = administrator(c);
    return admin instanceof Response ? admin : handler(c);
}

async function adminWrite(
    c: Context<AppEnv>,
    deps: PayoutRouteDeps,
    handler: (
        c: Context<AppEnv>,
        admin: { userId: string },
        deps: PayoutRouteDeps,
    ) => Promise<Response>,
) {
    const admin = administrator(c);
    if (admin instanceof Response) return admin;
    const actor = c.get("actor");
    if (!hasFreshStepUp(actor.kind === "user" ? actor.stepUpAtMs : null, deps.clock.nowUnixMs())) {
        return problemResponse(c, "step_up_required", "Confirm with your passkey to continue");
    }
    try {
        return await handler(c, admin, deps);
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === INSUFFICIENT_PRIVILEGE || code === NO_DATA_FOUND) return notFound(c);
        if (code === CHECK_VIOLATION)
            return problemResponse(c, "conflict", "The payout cannot take this change");
        if (code === FOREIGN_KEY_VIOLATION)
            return problemResponse(c, "invalid_request", "Invalid request");
        throw error;
    }
}

function payoutBody(row: PayoutRow) {
    return payoutSchema.parse({
        id: encodeId("pay", row.id),
        contractor_id: encodeId("usr", row.contractor_id),
        task_version_id: encodeId("tsv", row.task_version_id),
        amount_minor: row.amount_minor,
        currency: row.currency,
        paid_at: row.paid_at?.toISOString() ?? null,
        paid_reference: row.paid_reference,
        created_at: row.created_at.toISOString(),
    });
}

async function handleCreate(c: Context<AppEnv>, admin: { userId: string }, deps: PayoutRouteDeps) {
    const body = payoutCreateRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return problemResponse(c, "invalid_request", "Invalid request");
    const tx = c.get("tx");
    const id = await recordPayout(tx, {
        contractorId: decodeId("usr", body.data.contractor_id),
        versionId: decodeId("tsv", body.data.task_version_id),
        amountMinor: body.data.amount_minor,
        currency: body.data.currency,
        nowMs: deps.clock.nowUnixMs(),
    });
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: admin.userId,
        orgId: null,
        action: "payout.recorded",
        target: encodeId("pay", id),
        detail: { amount_minor: body.data.amount_minor, currency: body.data.currency },
    });
    const row = await getPayout(tx, id);
    if (row === null) throw new Error("a recorded payout is visible to the administrator");
    return c.json(payoutBody(row), 201);
}

async function handlePaid(c: Context<AppEnv>, admin: { userId: string }, deps: PayoutRouteDeps) {
    const id = idSchema("pay").safeParse(c.req.param("id"));
    const body = payoutPaidRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success)
        return problemResponse(c, "invalid_request", "Invalid request");
    const tx = c.get("tx");
    const payoutId = decodeId("pay", id.data);
    await markPayoutPaid(tx, payoutId, body.data.reference, deps.clock.nowUnixMs());
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: admin.userId,
        orgId: null,
        action: "payout.paid",
        target: encodeId("pay", payoutId),
    });
    const row = await getPayout(tx, payoutId);
    if (row === null) throw new Error("a paid payout is visible to the administrator");
    return c.json(payoutBody(row));
}

async function handleAdminList(c: Context<AppEnv>) {
    const rows = await listPayouts(c.get("tx"), { contractorId: null }, ORDER_PAGE_SIZE_MAX);
    return c.json(payoutsResponseSchema.parse({ payouts: rows.map(payoutBody) }));
}

async function handleMine(c: Context<AppEnv>) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const rows = await listPayouts(
        c.get("tx"),
        { contractorId: actor.userId },
        ORDER_PAGE_SIZE_MAX,
    );
    return c.json(payoutsResponseSchema.parse({ payouts: rows.map(payoutBody) }));
}
