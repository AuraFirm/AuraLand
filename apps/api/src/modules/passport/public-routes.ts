import { verifyResponseSchema } from "@aura/contracts/api/passport";
import { isUuidV7 } from "@aura/contracts/ids";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import type { ObjectStorage } from "../../platform/object-storage.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { verifyPublished } from "./public-verify.ts";
import { DID_KEY, JWKS_KEY, statusKey } from "./publish.ts";

export interface PublicPassportDeps {
    readonly clock: Clock;
    readonly storage: ObjectStorage;
    readonly publicOrigin: string;
}

// Public, unauthenticated and independent of the database (mounted outside the /v1 pipeline on purpose, which
// authenticates and opens a transaction). Cacheable, with stale answers allowed while the origin is down.
const VERIFY_CACHE = "public, max-age=60, stale-while-revalidate=3600, stale-if-error=86400";
const DOCUMENT_CACHE = "public, max-age=300, stale-while-revalidate=86400, stale-if-error=604800";
const DOCUMENT_BYTES_MAX = 64 * 1024;

export function publicPassportRoutes(deps: PublicPassportDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/credentials/:id", (c) => handleCredential(c, deps));
    routes.get("/status-lists/:list", (c) => handleList(c, deps));
    routes.get("/did.json", (c) => handleDocument(c, deps, DID_KEY, "application/did+json"));
    routes.get("/jwks.json", (c) => handleDocument(c, deps, JWKS_KEY, "application/json"));
    return routes;
}

async function handleCredential(c: Context<AppEnv>, deps: PublicPassportDeps) {
    const id = c.req.param("id") ?? "";
    const match = /^crd_(.+)$/.exec(id);
    if (match === null || !isUuidV7(match[1] ?? ""))
        return problemResponse(c, "not_found", "Not found");
    const token = c.req.query("s");
    if (token !== undefined && !/^[A-Za-z0-9_-]{20,64}$/.test(token)) {
        return problemResponse(c, "not_found", "Not found");
    }
    const result = await verifyPublished(deps.storage, {
        id,
        publicOrigin: deps.publicOrigin,
        nowMs: deps.clock.nowUnixMs(),
        shareToken: token,
    });
    // A link's answer is for whoever holds the link: no shared cache may keep it.
    if (token !== undefined) c.header("Cache-Control", "private, max-age=60");
    else
        c.header(
            "Cache-Control",
            result.outcome === "unknown" ? "public, max-age=30" : VERIFY_CACHE,
        );
    return c.json(verifyResponseSchema.parse(result));
}

async function handleList(c: Context<AppEnv>, deps: PublicPassportDeps) {
    const list = c.req.param("list") ?? "";
    if (!/^\d{1,6}$/.test(list)) return problemResponse(c, "not_found", "Not found");
    return serve(c, deps, statusKey(Number(list)), "application/vc+jwt");
}

const handleDocument = (c: Context<AppEnv>, deps: PublicPassportDeps, key: string, type: string) =>
    serve(c, deps, key, type);

async function serve(c: Context<AppEnv>, deps: PublicPassportDeps, key: string, type: string) {
    const found = await deps.storage.getSmall(key, DOCUMENT_BYTES_MAX);
    if (found.kind !== "found") return problemResponse(c, "not_found", "Not found");
    c.header("Cache-Control", DOCUMENT_CACHE);
    c.header("Content-Type", type);
    return c.body(new Uint8Array(found.bytes));
}
