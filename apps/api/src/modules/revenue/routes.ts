import {
    batchesResponseSchema,
    batchSchema,
    bookRevenueRequestSchema,
    createBatchRequestSchema,
    earningsResponseSchema,
    markBatchPaidRequestSchema,
    setterTermsRequestSchema,
} from "@aura/contracts/api/revenue";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { hasFreshStepUp } from "../../platform/step-up.ts";
import * as q from "./queries.ts";

export interface RevenueRouteDeps {
    readonly clock: Clock;
}

const NO_DATA_FOUND = "P0002";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const OBJECT_NOT_IN_STATE = "55000";
const INSUFFICIENT_PRIVILEGE = "42501";

// Setter revenue share (Stage 9, slice 8): platform administrators, behind a fresh passkey check, set terms, book revenue and run
// payout batches; a setter reads their own balance. Everyone else gets the 404 they would for a route that does not exist.
export function revenueRoutes(deps: RevenueRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.put("/admin/tasks/:id/setter-terms", (c) => admin(c, deps, setTerms));
    routes.post("/admin/orders/:id/revenue", (c) => admin(c, deps, book));
    routes.post("/admin/payout-batches", (c) => admin(c, deps, createBatch));
    routes.get("/admin/payout-batches", (c) => admin(c, deps, listBatches, false));
    routes.post("/admin/payout-batches/:id/paid", (c) => admin(c, deps, markPaid));
    routes.post("/admin/payout-batches/:id/cancel", (c) => admin(c, deps, cancel));
    routes.get("/me/earnings", handleEarnings);
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");
const invalid = (c: Context<AppEnv>, detail?: string) =>
    problemResponse(c, "invalid_request", "Invalid request", detail);
type Admin = { userId: string };
type Handler = (c: Context<AppEnv>, who: Admin, deps: RevenueRouteDeps) => Promise<Response>;

async function admin(
    c: Context<AppEnv>,
    deps: RevenueRouteDeps,
    handler: Handler,
    change = true,
): Promise<Response> {
    const actor = c.get("actor");
    if (actor.kind === "anonymous")
        return problemResponse(c, "unauthenticated", "Authentication required");
    if (actor.kind !== "user" || actor.platformRole !== "admin") return notFound(c);
    if (change && !hasFreshStepUp(actor.stepUpAtMs, deps.clock.nowUnixMs()))
        return problemResponse(c, "step_up_required", "Confirm with your passkey to continue");
    try {
        return await handler(c, { userId: actor.userId }, deps);
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === NO_DATA_FOUND || code === INSUFFICIENT_PRIVILEGE) return notFound(c);
        if (code === CHECK_VIOLATION) return invalid(c);
        if (code === UNIQUE_VIOLATION)
            return problemResponse(c, "conflict", "Conflict", "already booked");
        if (code === OBJECT_NOT_IN_STATE)
            return problemResponse(c, "conflict", "Conflict", "this batch is not waiting");
        throw error;
    }
}

async function audit(
    c: Context<AppEnv>,
    who: Admin,
    action: string,
    target: string,
    detail: Record<string, string | number> = {},
) {
    await appendAudit(c.get("tx"), {
        actorKind: "user",
        actorUserId: who.userId,
        orgId: null,
        action,
        target,
        detail,
    });
}

const setTerms: Handler = async (c, who, deps) => {
    const task = idSchema("tsk").safeParse(c.req.param("id"));
    const body = setterTermsRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!task.success || !body.success) return invalid(c);
    await q.setTerms(c.get("tx"), {
        task: decodeId("tsk", task.data),
        user: decodeId("usr", body.data.user_id),
        bps: body.data.share_bps,
        nowMs: deps.clock.nowUnixMs(),
    });
    await audit(c, who, "revenue.terms_set", task.data, {
        user: body.data.user_id,
        share_bps: body.data.share_bps,
    });
    return c.body(null, 204);
};

const book: Handler = async (c, who, deps) => {
    const order = idSchema("ord").safeParse(c.req.param("id"));
    const body = bookRevenueRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!order.success || !body.success) return invalid(c);
    await q.bookRevenue(c.get("tx"), {
        order: decodeId("ord", order.data),
        version: decodeId("tsv", body.data.task_version_id),
        amount: body.data.amount_minor,
        currency: body.data.currency,
        nowMs: deps.clock.nowUnixMs(),
    });
    await audit(c, who, "revenue.booked", order.data, {
        amount_minor: body.data.amount_minor,
        currency: body.data.currency,
    });
    return c.body(null, 201);
};

const createBatch: Handler = async (c, who, deps) => {
    const body = createBatchRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const tx = c.get("tx");
    const id = await q.createBatch(tx, {
        currency: body.data.currency,
        minimum: body.data.minimum_minor,
        nowMs: deps.clock.nowUnixMs(),
    });
    await audit(c, who, "revenue.batch_created", encodeId("pbt", id), {
        currency: body.data.currency,
    });
    return c.json(batchSchema.parse(await q.getBatch(tx, id)), 201);
};

const listBatches: Handler = async (c) =>
    c.json(batchesResponseSchema.parse({ batches: await q.listBatches(c.get("tx")) }));

const markPaid: Handler = async (c, who, deps) => {
    const id = idSchema("pbt").safeParse(c.req.param("id"));
    const body = markBatchPaidRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) return invalid(c);
    const tx = c.get("tx");
    await q.markPaid(tx, decodeId("pbt", id.data), body.data.reference, deps.clock.nowUnixMs());
    await audit(c, who, "revenue.batch_paid", id.data);
    return c.json(batchSchema.parse(await q.getBatch(tx, decodeId("pbt", id.data))));
};

const cancel: Handler = async (c, who) => {
    const id = idSchema("pbt").safeParse(c.req.param("id"));
    if (!id.success) return invalid(c);
    await q.cancelBatch(c.get("tx"), decodeId("pbt", id.data));
    await audit(c, who, "revenue.batch_cancelled", id.data);
    return c.body(null, 204);
};

async function handleEarnings(c: Context<AppEnv>) {
    if (c.get("actor").kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    return c.json(earningsResponseSchema.parse({ balances: await q.myEarnings(c.get("tx")) }));
}
