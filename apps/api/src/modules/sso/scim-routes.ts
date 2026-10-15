import { createHash } from "node:crypto";
import { isUuidV7 } from "@aura/contracts/ids";
import type { Sql } from "@aura/db/client";
import { withRequestContext } from "@aura/db/context";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import {
    activeFrom,
    ERROR_SCHEMA,
    emailFromFilter,
    LIST_SCHEMA,
    parseCreate,
    toResource,
} from "./scim.ts";
import * as q from "./scim-queries.ts";

export interface ScimRouteDeps {
    readonly sql: Sql;
    readonly clock: Clock;
}

const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;
const SCIM_JSON = "application/scim+json";
const PAGE_MAX = 100;

// SCIM 2.0 Users (Stage 9, slice 6c), authenticated by a bearer token that belongs to one organization. No session and no CSRF:
// the token is the credential. Every failure is answered in SCIM's own error shape.
export function scimRoutes(deps: ScimRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/Users", (c) => withOrg(c, deps, create));
    routes.get("/Users", (c) => withOrg(c, deps, list));
    routes.get("/Users/:id", (c) => withOrg(c, deps, read));
    routes.put("/Users/:id", (c) => withOrg(c, deps, change));
    routes.patch("/Users/:id", (c) => withOrg(c, deps, change));
    routes.delete("/Users/:id", (c) => withOrg(c, deps, remove));
    return routes;
}

type Handler = (c: Context<AppEnv>, deps: ScimRouteDeps, org: string) => Promise<Response>;

function problem(
    c: Context<AppEnv>,
    status: 400 | 401 | 403 | 404 | 409,
    detail: string,
    scimType?: string,
): Response {
    return c.json(
        {
            schemas: [ERROR_SCHEMA],
            status: String(status),
            ...(scimType === undefined ? {} : { scimType }),
            detail,
        },
        status,
        { "Content-Type": SCIM_JSON },
    );
}
function ok(c: Context<AppEnv>, body: unknown, status: 200 | 201 = 200): Response {
    return c.json(body, status, { "Content-Type": SCIM_JSON });
}

async function withOrg(
    c: Context<AppEnv>,
    deps: ScimRouteDeps,
    handler: Handler,
): Promise<Response> {
    const bearer = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(
        c.req.header("authorization") ?? "",
    )?.[1];
    if (bearer === undefined) return problem(c, 401, "A bearer token is required");
    const hash = createHash("sha256").update(bearer).digest();
    const org = await withRequestContext(deps.sql, WORKER, (tx) =>
        q.authenticate(tx, hash, deps.clock.nowUnixMs()),
    );
    if (org === null) return problem(c, 401, "The token is not valid");
    return handler(c, deps, org);
}

const inWorker = <T>(deps: ScimRouteDeps, work: Parameters<typeof withRequestContext<T>>[2]) =>
    withRequestContext(deps.sql, WORKER, work);

async function create(c: Context<AppEnv>, deps: ScimRouteDeps, org: string) {
    const body = parseCreate(await c.req.json().catch(() => null));
    if (body === null) return problem(c, 400, "userName must be an email address", "invalidValue");
    const made = await inWorker(deps, async (tx) => {
        const result = await q.provision(tx, { org, ...body, nowMs: deps.clock.nowUnixMs() });
        const person = result.userId === null ? null : await q.getPerson(tx, org, result.userId);
        return { result, person };
    });
    if (made.result.outcome === "wrong_domain")
        return problem(
            c,
            400,
            "That address is not in a domain this organization has verified",
            "invalidValue",
        );
    if (made.result.outcome === "full")
        return problem(c, 403, "The organization's plan has no room for another member");
    if (made.result.outcome === "exists")
        return problem(c, 409, "That person is already provisioned", "uniqueness");
    return made.person === null
        ? problem(c, 404, "Not found")
        : ok(c, toResource(made.person), 201);
}

async function list(c: Context<AppEnv>, deps: ScimRouteDeps, org: string) {
    const filter = emailFromFilter(c.req.query("filter"));
    if (!filter.ok)
        return problem(
            c,
            400,
            'Only the filter userName eq "address" is supported',
            "invalidFilter",
        );
    const startIndex = Math.max(Number.parseInt(c.req.query("startIndex") ?? "1", 10) || 1, 1);
    const count = Math.min(
        Math.max(Number.parseInt(c.req.query("count") ?? "50", 10) || 0, 0),
        PAGE_MAX,
    );
    const found = await inWorker(deps, (tx) =>
        q.listPeople(tx, org, filter.email, startIndex, count),
    );
    return ok(c, {
        schemas: [LIST_SCHEMA],
        totalResults: found.total,
        startIndex,
        itemsPerPage: found.people.length,
        Resources: found.people.map(toResource),
    });
}

function idOf(c: Context<AppEnv>): string | null {
    const id = c.req.param("id") ?? "";
    return isUuidV7(id) ? id : null;
}

async function read(c: Context<AppEnv>, deps: ScimRouteDeps, org: string) {
    const id = idOf(c);
    if (id === null) return problem(c, 404, "Not found");
    const person = await inWorker(deps, (tx) => q.getPerson(tx, org, id));
    return person === null ? problem(c, 404, "Not found") : ok(c, toResource(person));
}

async function change(c: Context<AppEnv>, deps: ScimRouteDeps, org: string) {
    const id = idOf(c);
    if (id === null) return problem(c, 404, "Not found");
    const active = activeFrom(await c.req.json().catch(() => null));
    const result = await inWorker(deps, async (tx) => {
        const outcome =
            active === null ? "ok" : await q.setActive(tx, org, id, active, deps.clock.nowUnixMs());
        return { outcome, person: await q.getPerson(tx, org, id) };
    });
    if (result.outcome === "missing" || result.person === null) return problem(c, 404, "Not found");
    if (result.outcome === "full")
        return problem(c, 403, "The organization's plan has no room for another member");
    return ok(c, toResource(result.person));
}

async function remove(c: Context<AppEnv>, deps: ScimRouteDeps, org: string) {
    const id = idOf(c);
    if (id === null) return problem(c, 404, "Not found");
    const removed = await inWorker(deps, (tx) =>
        q.removePerson(tx, org, id, deps.clock.nowUnixMs()),
    );
    return removed ? c.body(null, 204) : problem(c, 404, "Not found");
}
