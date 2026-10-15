import type { Sql } from "@aura/db/client";
import { withRequestContext } from "@aura/db/context";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { parseProviderEvent, planChangeOf } from "./provider-events.ts";
import { verifyStripeSignature } from "./stripe-signature.ts";

export interface WebhookRouteDeps {
    readonly sql: Sql;
    readonly clock: Clock;
    // Undefined means billing webhooks are not configured: the route answers 404 as if it did not exist.
    readonly stripeSecret: string | undefined;
}

const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;

// The payment provider's webhook (Stage 9, slice 3). No session and no CSRF: the signature over the exact bytes is the
// credential, checked before anything is parsed. A valid event is applied at most once (the database remembers its id).
export function webhookRoutes(deps: WebhookRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/stripe", async (c) => {
        if (deps.stripeSecret === undefined) return problemResponse(c, "not_found", "Not found");
        const rawBody = await c.req.text();
        const verdict = verifyStripeSignature(
            rawBody,
            c.req.header("stripe-signature"),
            deps.stripeSecret,
            deps.clock.nowUnixMs(),
        );
        // One answer for every failure: the sender learns nothing about which check failed.
        if (verdict !== "ok") return problemResponse(c, "invalid_request", "Invalid request");
        const event = parseProviderEvent(rawBody);
        if (event === null) return problemResponse(c, "invalid_request", "Invalid request");
        const change = planChangeOf(event);
        const nowMs = deps.clock.nowUnixMs();
        const outcome = await withRequestContext(deps.sql, WORKER, async (tx) => {
            const [row] =
                await tx`select apply_provider_event(${event.id}, ${event.type}, ${new Date(event.created * 1000)}, ${change.org}, ${change.plan}, ${change.billingRef}, ${new Date(nowMs)}) as outcome`;
            return String(row?.["outcome"]);
        });
        return c.json({ received: true, outcome });
    });
    return routes;
}
