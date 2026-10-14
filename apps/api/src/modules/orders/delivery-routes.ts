import {
    deliveriesResponseSchema,
    deliverySchema,
    downloadRequestSchema,
    downloadSchema,
} from "@aura/contracts/api/deliveries";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import {
    DELIVERY_DOWNLOADS_PER_MINUTE_PER_USER_MAX,
    DELIVERY_LINK_LIFETIME_S,
    ORDER_PAGE_SIZE_MAX,
} from "@aura/contracts/limits";
import { appendAudit } from "@aura/db/audit";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import { bundleKey, deliveryBundleKey, type ObjectStorage } from "../../platform/object-storage.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { RateLimitRule } from "../../platform/rate-limit.ts";
import {
    consumeRateLimit,
    type RateLimitDeps,
    refuseRateLimited,
} from "../../rate-limit-middleware.ts";
import { clientAddress } from "../../request-info.ts";
import { type DeliveryRow, getDelivery, issueDownload, listDeliveries } from "./queries.ts";
import { deliveryStatus, manifestSummarySchema } from "./rules.ts";

export interface DeliveryRouteDeps extends Pick<RateLimitDeps, "sql" | "clock" | "key"> {
    readonly storage: ObjectStorage;
    readonly trustEdge: boolean;
}

const DOWNLOAD_BY_USER: RateLimitRule = {
    name: "delivery-download:user",
    max: DELIVERY_DOWNLOADS_PER_MINUTE_PER_USER_MAX,
    windowS: 60,
};

// Customers read their organization's deliveries and fetch bundles through short-lived links. Row-level
// security limits what they can list or read; the issue function decides and logs each link.
export function deliveryRoutes(deps: DeliveryRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/deliveries", handleList(deps));
    routes.get("/deliveries/:id", handleGet(deps));
    routes.post("/deliveries/:id/downloads", (c) => handleDownload(c, deps));
    return routes;
}

const unauthenticated = (c: Context<AppEnv>) =>
    problemResponse(c, "unauthenticated", "Authentication required");
const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");

function body(row: DeliveryRow, nowMs: number, withManifest: boolean) {
    const status = deliveryStatus(row.state, row.expires_at.getTime(), nowMs);
    const manifest = withManifest && row.manifest !== null ? row.manifest : null;
    const summary = manifest === null ? null : manifestSummarySchema.parse(JSON.parse(manifest));
    return deliverySchema.parse({
        id: encodeId("dlv", row.id),
        order_id: encodeId("ord", row.order_id),
        order_title: row.order_title,
        status,
        expires_at: row.expires_at.toISOString(),
        created_at: row.created_at.toISOString(),
        manifest,
        manifest_sha256:
            manifest === null || row.manifest_sha256 === null
                ? null
                : Buffer.from(row.manifest_sha256).toString("hex"),
        items:
            summary?.items.map((item) => ({
                task_version_id: item.task_version_id,
                title: item.title,
                bundle_bytes: item.bundle.bytes,
                bundle_sha256: item.bundle.sha256,
                validation: item.validation,
            })) ?? null,
    });
}

const handleList = (deps: DeliveryRouteDeps) => async (c: Context<AppEnv>) => {
    if (c.get("actor").kind !== "user") return unauthenticated(c);
    const rows = await listDeliveries(c.get("tx"), ORDER_PAGE_SIZE_MAX);
    const nowMs = deps.clock.nowUnixMs();
    return c.json(
        deliveriesResponseSchema.parse({ deliveries: rows.map((row) => body(row, nowMs, false)) }),
    );
};

const handleGet = (deps: DeliveryRouteDeps) => async (c: Context<AppEnv>) => {
    if (c.get("actor").kind !== "user") return unauthenticated(c);
    const id = idSchema("dlv").safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const row = await getDelivery(c.get("tx"), decodeId("dlv", id.data));
    if (row === null) return notFound(c);
    c.header("Cache-Control", "no-store");
    return c.json(body(row, deps.clock.nowUnixMs(), true));
};

async function handleDownload(c: Context<AppEnv>, deps: DeliveryRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind !== "user") return unauthenticated(c);
    const id = idSchema("dlv").safeParse(c.req.param("id"));
    const request = downloadRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!id.success) return notFound(c);
    if (!request.success) return problemResponse(c, "invalid_request", "Invalid request");
    const verdict = await consumeRateLimit(deps, DOWNLOAD_BY_USER, actor.userId);
    if (!verdict.allowed) return refuseRateLimited(c, verdict);
    const tx = c.get("tx");
    const deliveryId = decodeId("dlv", id.data);
    const decision = await issueDownload(tx, {
        deliveryId,
        versionId: decodeId("tsv", request.data.task_version_id),
        address: clientAddress(c, deps.trustEdge),
        nowMs: deps.clock.nowUnixMs(),
        lifetimeS: DELIVERY_LINK_LIFETIME_S,
    });
    if (decision === null) return notFound(c);
    if (decision.status !== "ok") {
        return problemResponse(c, "conflict", `This delivery is ${decision.status}`);
    }
    // The key is built from ids the database vouched for; if the link cannot be made, the request
    // fails and the transaction rolls the log row back, so a log row always means a link was issued.
    const url = await deps.storage.downloadUrl(
        decision.is_original
            ? bundleKey(decision.task_org_id, decision.bundle_sha256)
            : deliveryBundleKey(decision.customer_org_id, deliveryId, decision.bundle_sha256),
        DELIVERY_LINK_LIFETIME_S,
    );
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId: null,
        action: "delivery.download_issued",
        target: encodeId("dlv", deliveryId),
        detail: { task_version_id: request.data.task_version_id },
    });
    c.header("Cache-Control", "no-store");
    return c.json(downloadSchema.parse({ url, expires_in_s: DELIVERY_LINK_LIFETIME_S }));
}
