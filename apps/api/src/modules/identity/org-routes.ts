import {
    memberRoleRequestSchema,
    memberSchema,
    membersResponseSchema,
    orgCreateRequestSchema,
    orgSchema,
    orgsResponseSchema,
    orgUpdateRequestSchema,
} from "@aura/contracts/api/orgs";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { withRequestContext } from "@aura/db/context";
import {
    CHECK_VIOLATION,
    postgresConstraint,
    postgresErrorCode,
    UNIQUE_VIOLATION,
} from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { RateLimitRule } from "../../platform/rate-limit.ts";
import {
    consumeRateLimit,
    type RateLimitDeps,
    refuseRateLimited,
} from "../../rate-limit-middleware.ts";
import { authorize, type Decision, hasFreshStepUp, type Subject } from "./authorize.ts";
import { ORGS_CREATED_PER_USER_PER_DAY_MAX } from "./limits.ts";
import {
    createOrg,
    getMemberRole,
    getMyOrg,
    listMembers,
    listMyOrgs,
    type OrgRow,
    removeMember,
    renameOrg,
    setMemberRole,
} from "./org-queries.ts";
import { createPgSessionStore } from "./queries.ts";

export type OrgRouteDeps = Pick<RateLimitDeps, "sql" | "clock" | "key">;

const DAY_S = 24 * 60 * 60;
const CREATE_BY_USER: RateLimitRule = {
    name: "org-create:user",
    max: ORGS_CREATED_PER_USER_PER_DAY_MAX,
    windowS: DAY_S,
};

// Organization and membership routes. They run in the request transaction as `aura_app`, so
// PostgreSQL row-level security applies on top of the `authorize` checks here.
export function orgRoutes(deps: OrgRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/orgs", (c) => handleCreate(c, deps));
    routes.get("/orgs", handleList);
    routes.get("/orgs/:id", handleGet);
    routes.patch("/orgs/:id", handleRename);
    routes.get("/orgs/:id/members", handleMembers);
    routes.patch("/orgs/:id/members/:userId", (c) => handleChangeRole(c, deps));
    routes.delete("/orgs/:id/members/:userId", (c) => handleRemove(c, deps));
    return routes;
}

interface Caller extends Subject {
    readonly sessionId: string;
    readonly stepUpAtMs: number | null;
}

function caller(c: Context<AppEnv>): Caller | null {
    const actor = c.get("actor");
    return actor.kind === "user"
        ? {
              userId: actor.userId,
              orgs: actor.orgs,
              sessionId: actor.sessionId,
              stepUpAtMs: actor.stepUpAtMs,
          }
        : null;
}

const unauthenticated = (c: Context<AppEnv>) =>
    problemResponse(c, "unauthenticated", "Authentication required");

const readJson = (c: Context<AppEnv>): Promise<unknown> =>
    c.req.json().then(
        (body: unknown) => body,
        () => null,
    );

function orgBody(row: OrgRow) {
    return orgSchema.parse({
        id: encodeId("org", row.id),
        kind: row.kind,
        slug: row.slug,
        name: row.name,
        verification_state: row.verification_state,
        data_region: row.data_region,
        created_at: row.created_at.toISOString(),
        role: row.role,
    });
}

// A person outside the organization gets 404, whatever they asked for.
function refuse(c: Context<AppEnv>, decision: Decision): Response | null {
    if (decision.allowed) return null;
    return decision.reason === "not_member"
        ? problemResponse(c, "not_found", "Not found")
        : problemResponse(c, "forbidden", "Forbidden");
}

function orgIdParam(c: Context<AppEnv>): string | null {
    const parsed = idSchema("org").safeParse(c.req.param("id"));
    return parsed.success ? decodeId("org", parsed.data) : null;
}

function userIdParam(c: Context<AppEnv>): string | null {
    const parsed = idSchema("usr").safeParse(c.req.param("userId"));
    return parsed.success ? decodeId("usr", parsed.data) : null;
}

const invalid = (c: Context<AppEnv>) => problemResponse(c, "invalid_request", "Invalid request");

async function handleCreate(c: Context<AppEnv>, deps: OrgRouteDeps) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const body = orgCreateRequestSchema.safeParse(await readJson(c));
    if (!body.success) return invalid(c);
    const verdict = await consumeRateLimit(deps, CREATE_BY_USER, who.userId);
    if (!verdict.allowed) return refuseRateLimited(c, verdict);
    const tx = c.get("tx");
    let orgId: string;
    try {
        orgId = await createOrg(tx, {
            kind: body.data.kind,
            slug: body.data.slug,
            name: body.data.name,
            region: body.data.data_region,
        });
    } catch (error) {
        const code = postgresErrorCode(error);
        if (code === UNIQUE_VIOLATION || postgresConstraint(error) === "orgs_personal_slug") {
            return problemResponse(c, "conflict", "That address is taken");
        }
        if (code === CHECK_VIOLATION) {
            return problemResponse(
                c,
                "conflict",
                "You belong to the maximum number of organizations",
            );
        }
        throw error;
    }
    const row = await getMyOrg(tx, who.userId, orgId);
    if (row === null) throw new Error("a new organization is visible to its creator");
    await appendAudit(tx, orgAudit(who.userId, orgId, "org.created", { kind: row.kind }));
    return c.json(orgBody(row), 201);
}

function orgAudit(
    userId: string,
    orgId: string,
    action: string,
    detail: Record<string, string> = {},
    target: string = encodeId("org", orgId),
) {
    return { actorKind: "user", actorUserId: userId, orgId, action, target, detail } as const;
}

async function handleList(c: Context<AppEnv>) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const rows = await listMyOrgs(c.get("tx"), who.userId);
    return c.json(orgsResponseSchema.parse({ items: rows.map(orgBody) }));
}

async function handleGet(c: Context<AppEnv>) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const orgId = orgIdParam(c);
    if (orgId === null) return invalid(c);
    const denied = refuse(c, authorize(who, { kind: "org.read", orgId }));
    if (denied !== null) return denied;
    const row = await getMyOrg(c.get("tx"), who.userId, orgId);
    return row === null ? problemResponse(c, "not_found", "Not found") : c.json(orgBody(row));
}

async function handleRename(c: Context<AppEnv>) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const orgId = orgIdParam(c);
    const body = orgUpdateRequestSchema.safeParse(await readJson(c));
    if (orgId === null || !body.success) return invalid(c);
    const denied = refuse(c, authorize(who, { kind: "org.update", orgId }));
    if (denied !== null) return denied;
    const tx = c.get("tx");
    if (!(await renameOrg(tx, orgId, body.data.name)))
        return problemResponse(c, "not_found", "Not found");
    await appendAudit(tx, orgAudit(who.userId, orgId, "org.updated"));
    const row = await getMyOrg(tx, who.userId, orgId);
    if (row === null) throw new Error("the organization is visible to its member");
    return c.json(orgBody(row));
}

async function handleMembers(c: Context<AppEnv>) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const orgId = orgIdParam(c);
    if (orgId === null) return invalid(c);
    const denied = refuse(c, authorize(who, { kind: "members.read", orgId }));
    if (denied !== null) return denied;
    const rows = await listMembers(c.get("tx"), orgId);
    const items = rows.map((row) =>
        memberSchema.parse({
            user_id: encodeId("usr", row.user_id),
            handle: row.handle,
            display_name: row.display_name,
            role: row.role,
            joined_at: row.created_at.toISOString(),
        }),
    );
    return c.json(membersResponseSchema.parse({ items }));
}

const LAST_OWNER = "An organization must keep at least one owner";

async function handleChangeRole(c: Context<AppEnv>, deps: OrgRouteDeps) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const orgId = orgIdParam(c);
    const targetUserId = userIdParam(c);
    const body = memberRoleRequestSchema.safeParse(await readJson(c));
    if (orgId === null || targetUserId === null || !body.success) return invalid(c);
    const tx = c.get("tx");
    const targetRole = await getMemberRole(tx, orgId, targetUserId);
    const denied = refuse(
        c,
        authorize(who, {
            kind: "members.change_role",
            orgId,
            targetUserId,
            targetRole: targetRole ?? "member",
            newRole: body.data.role,
        }),
    );
    if (denied !== null) return denied;
    if (targetRole === null) return problemResponse(c, "not_found", "Not found");
    // Changing who holds power is a privileged action: it needs a fresh passkey check.
    if (!hasFreshStepUp(who.stepUpAtMs, deps.clock.nowUnixMs())) return stepUpRequired(c);
    try {
        if (!(await setMemberRole(tx, orgId, targetUserId, body.data.role))) {
            return problemResponse(c, "not_found", "Not found");
        }
    } catch (error) {
        if (postgresErrorCode(error) === CHECK_VIOLATION)
            return problemResponse(c, "conflict", LAST_OWNER);
        throw error;
    }
    const detail = { from: targetRole, to: body.data.role };
    await appendAudit(
        tx,
        orgAudit(
            who.userId,
            orgId,
            "org.member_role_changed",
            detail,
            encodeId("usr", targetUserId),
        ),
    );
    if (body.data.role !== "member") await endSessionsOf(deps, targetUserId, who);
    return c.body(null, 204);
}

// Someone who just gained power signs in again, so their new sessions carry the stricter idle limit.
// The person making the change keeps their own session.
async function endSessionsOf(deps: OrgRouteDeps, userId: string, who: Caller): Promise<void> {
    await withRequestContext(
        deps.sql,
        { role: "aura_auth", actorKind: "anonymous", userId: null, orgIds: [] },
        (tx) =>
            createPgSessionStore(tx).revokeAllForUser(
                userId,
                deps.clock.nowUnixMs(),
                "privilege_change",
                userId === who.userId ? who.sessionId : null,
            ),
    );
}

const stepUpRequired = (c: Context<AppEnv>) =>
    problemResponse(c, "step_up_required", "Confirm with your passkey to continue");

async function handleRemove(c: Context<AppEnv>, deps: OrgRouteDeps) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const orgId = orgIdParam(c);
    const targetUserId = userIdParam(c);
    if (orgId === null || targetUserId === null) return invalid(c);
    const tx = c.get("tx");
    const targetRole = await getMemberRole(tx, orgId, targetUserId);
    const denied = refuse(
        c,
        authorize(who, {
            kind: "members.remove",
            orgId,
            targetUserId,
            targetRole: targetRole ?? "member",
        }),
    );
    if (denied !== null) return denied;
    if (targetRole === null) return problemResponse(c, "not_found", "Not found");
    // Leaving needs nothing extra; removing an owner or admin is privileged.
    const privileged = targetUserId !== who.userId && targetRole !== "member";
    if (privileged && !hasFreshStepUp(who.stepUpAtMs, deps.clock.nowUnixMs())) {
        return stepUpRequired(c);
    }
    try {
        if (!(await removeMember(tx, orgId, targetUserId)))
            return problemResponse(c, "not_found", "Not found");
    } catch (error) {
        if (postgresErrorCode(error) === CHECK_VIOLATION)
            return problemResponse(c, "conflict", LAST_OWNER);
        throw error;
    }
    const action = targetUserId === who.userId ? "org.member_left" : "org.member_removed";
    await appendAudit(tx, orgAudit(who.userId, orgId, action, {}, encodeId("usr", targetUserId)));
    return c.body(null, 204);
}
