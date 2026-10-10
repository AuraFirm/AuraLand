import type { InvitableRole } from "@aura/contracts/api/invitations";
import {
    invitationAcceptedSchema,
    invitationAcceptRequestSchema,
    invitationCreateRequestSchema,
    invitationSchema,
    invitationsResponseSchema,
} from "@aura/contracts/api/invitations";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import type { Sql } from "@aura/db/client";
import { withRequestContext } from "@aura/db/context";
import { CHECK_VIOLATION, postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { type MailPort, MailUnavailableError } from "../../platform/mail.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { RateLimitRule } from "../../platform/rate-limit.ts";
import type { Rng } from "../../platform/rng.ts";
import { consumeRateLimit, refuseRateLimited } from "../../rate-limit-middleware.ts";
import { authorize, hasFreshStepUp } from "./authorize.ts";
import {
    addMember,
    consumeInvitation,
    getInvitation,
    type InvitationRow,
    insertInvitation,
    listPendingInvitations,
    loadVerifiedEmail,
    revokeInvitation,
    supersedeInvitations,
} from "./invitation-queries.ts";
import {
    INVITATION_TTL_S,
    INVITATIONS_PER_ORG_PER_HOUR_MAX,
    LOGIN_SECRET_BYTES,
} from "./limits.ts";
import { hashSecret } from "./login.ts";
import { getMyOrg } from "./org-queries.ts";

export interface InvitationRouteDeps {
    readonly sql: Sql;
    readonly clock: Clock;
    readonly rng: Rng;
    readonly key: Buffer;
    readonly mail: MailPort;
    readonly publicOrigin: string;
}

const INVITE_BY_ORG: RateLimitRule = {
    name: "org-invite:org",
    max: INVITATIONS_PER_ORG_PER_HOUR_MAX,
    windowS: 3600,
};
const IDENTITY_CONTEXT = {
    role: "aura_auth",
    actorKind: "anonymous",
    userId: null,
    orgIds: [],
} as const;

// Invitations to join an organization. Sending and listing run in the request transaction as
// `aura_app`; accepting runs its own `aura_auth` transaction, because it creates the membership.
export function invitationRoutes(deps: InvitationRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/orgs/:id/invitations", (c) => handleInvite(c, deps));
    routes.get("/orgs/:id/invitations", (c) => handleList(c, deps));
    routes.delete("/orgs/:id/invitations/:invitationId", (c) => handleRevoke(c, deps));
    routes.post("/invitations/accept", (c) => handleAccept(c, deps));
    return routes;
}

const readJson = (c: Context<AppEnv>): Promise<unknown> =>
    c.req.json().then(
        (body: unknown) => body,
        () => null,
    );

function itemBody(row: InvitationRow) {
    return invitationSchema.parse({
        id: encodeId("inv", row.id),
        email: row.email,
        role: row.role,
        created_at: row.created_at.toISOString(),
        expires_at: row.expires_at.toISOString(),
    });
}

function orgIdOf(c: Context<AppEnv>): string | null {
    const parsed = idSchema("org").safeParse(c.req.param("id"));
    return parsed.success ? decodeId("org", parsed.data) : null;
}

const invalid = (c: Context<AppEnv>) => problemResponse(c, "invalid_request", "Invalid request");
const stepUpRequired = (c: Context<AppEnv>) =>
    problemResponse(c, "step_up_required", "Confirm with your passkey to continue");

async function handleInvite(c: Context<AppEnv>, deps: InvitationRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const orgId = orgIdOf(c);
    if (orgId === null) return invalid(c);
    // Outsiders learn nothing, not even whether their request was well formed.
    if (!authorize(actor, { kind: "org.read", orgId }).allowed) {
        return problemResponse(c, "not_found", "Not found");
    }
    const body = invitationCreateRequestSchema.safeParse(await readJson(c));
    if (!body.success) return invalid(c);
    const decision = authorize(actor, { kind: "members.invite", orgId, role: body.data.role });
    if (!decision.allowed) {
        return decision.reason === "not_member"
            ? problemResponse(c, "not_found", "Not found")
            : problemResponse(c, "forbidden", "Forbidden");
    }
    const nowMs = deps.clock.nowUnixMs();
    // Inviting someone to be an admin hands out power, so it needs a fresh passkey check.
    if (body.data.role === "admin" && !hasFreshStepUp(actor.stepUpAtMs, nowMs)) {
        return stepUpRequired(c);
    }
    const verdict = await consumeRateLimit(deps, INVITE_BY_ORG, orgId);
    if (!verdict.allowed) return refuseRateLimited(c, verdict);
    return sendInvitation(c, deps, { orgId, userId: actor.userId, ...body.data });
}

async function sendInvitation(
    c: Context<AppEnv>,
    deps: InvitationRouteDeps,
    input: { orgId: string; userId: string; email: string; role: InvitableRole },
) {
    const tx = c.get("tx");
    const nowMs = deps.clock.nowUnixMs();
    const token = Buffer.from(deps.rng.nextBytes(LOGIN_SECRET_BYTES)).toString("base64url");
    // Sending again replaces an earlier pending invitation to the same address.
    await supersedeInvitations(tx, input.orgId, input.email, nowMs);
    let id: string;
    try {
        id = await insertInvitation(tx, {
            ...input,
            tokenHash: hashSecret(deps.key, "invite", token),
            invitedBy: input.userId,
            nowMs,
            ttlS: INVITATION_TTL_S,
        });
    } catch (error) {
        if (postgresErrorCode(error) === CHECK_VIOLATION) {
            return problemResponse(
                c,
                "conflict",
                "This organization cannot take more invitations now",
            );
        }
        throw error;
    }
    const org = await getMyOrg(tx, input.userId, input.orgId);
    if (org === null) throw new Error("the inviting member can see their organization");
    // The mail goes out before the transaction commits: if it cannot be sent, nothing is saved.
    try {
        await deps.mail.send({
            to: input.email,
            subject: `You are invited to join ${org.name} on AuraLand`,
            text: invitationText(deps.publicOrigin, org.name, token),
        });
    } catch (error) {
        if (!(error instanceof MailUnavailableError)) throw error;
        return problemResponse(
            c,
            "unavailable",
            "Could not send the invitation. Try again shortly",
        );
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: input.userId,
        orgId: input.orgId,
        action: "org.invitation_sent",
        target: encodeId("inv", id),
        detail: { role: input.role },
    });
    const row = await getInvitation(tx, input.orgId, id);
    if (row === null) throw new Error("a new invitation is visible to its sender");
    return c.json(itemBody(row), 201);
}

function invitationText(origin: string, orgName: string, token: string): string {
    return [
        `You have been invited to join ${orgName} on AuraLand.`,
        "",
        "Sign in with the email address this message was sent to, then open this link:",
        `${origin}/invitations/accept#t=${token}`,
        "",
        "The link works for 7 days. If you were not expecting it, ignore this email.",
    ].join("\n");
}

async function handleList(c: Context<AppEnv>, deps: InvitationRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const orgId = orgIdOf(c);
    if (orgId === null) return invalid(c);
    const decision = authorize(actor, { kind: "keys.manage", orgId });
    if (!decision.allowed) {
        return decision.reason === "not_member"
            ? problemResponse(c, "not_found", "Not found")
            : problemResponse(c, "forbidden", "Forbidden");
    }
    const rows = await listPendingInvitations(c.get("tx"), orgId, deps.clock.nowUnixMs());
    return c.json(invitationsResponseSchema.parse({ items: rows.map(itemBody) }));
}

async function handleRevoke(c: Context<AppEnv>, deps: InvitationRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const orgId = orgIdOf(c);
    const invitation = idSchema("inv").safeParse(c.req.param("invitationId"));
    if (orgId === null || !invitation.success) return invalid(c);
    const decision = authorize(actor, { kind: "keys.manage", orgId });
    if (!decision.allowed) {
        return decision.reason === "not_member"
            ? problemResponse(c, "not_found", "Not found")
            : problemResponse(c, "forbidden", "Forbidden");
    }
    const tx = c.get("tx");
    const nowMs = deps.clock.nowUnixMs();
    if (!(await revokeInvitation(tx, orgId, decodeId("inv", invitation.data), nowMs))) {
        return problemResponse(c, "not_found", "Not found");
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: actor.userId,
        orgId,
        action: "org.invitation_revoked",
        target: invitation.data,
    });
    return c.body(null, 204);
}

const REFUSED = "That invitation did not work. Ask for a new one";

async function handleAccept(c: Context<AppEnv>, deps: InvitationRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const body = invitationAcceptRequestSchema.safeParse(await readJson(c));
    if (!body.success) return problemResponse(c, "invalid_request", REFUSED);
    const joined = await withRequestContext(deps.sql, IDENTITY_CONTEXT, async (tx) => {
        const email = await loadVerifiedEmail(tx, actor.userId);
        if (email === null) return null;
        const invitation = await consumeInvitation(tx, {
            tokenHash: hashSecret(deps.key, "invite", body.data.token),
            email,
            nowMs: deps.clock.nowUnixMs(),
        });
        if (invitation === null) return null;
        if (!(await addMember(tx, invitation.orgId, actor.userId, invitation.role))) {
            // Already a member: undo the acceptance by failing the transaction.
            throw new AlreadyMember();
        }
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: actor.userId,
            orgId: invitation.orgId,
            action: "org.member_joined",
            target: encodeId("usr", actor.userId),
            detail: { role: invitation.role },
        });
        return invitation.orgId;
    }).catch((error: unknown) => {
        // A full organization or a 20-organization person: the invitation stays usable.
        if (error instanceof AlreadyMember || postgresErrorCode(error) === CHECK_VIOLATION)
            return null;
        throw error;
    });
    if (joined === null) return problemResponse(c, "invalid_request", REFUSED);
    return c.json(
        invitationAcceptedSchema.parse({ status: "joined", org_id: encodeId("org", joined) }),
    );
}

class AlreadyMember extends Error {}
