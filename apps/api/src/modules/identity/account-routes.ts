import {
    authMethodsResponseSchema,
    deletionRequestResponseSchema,
    exportSchema,
    sessionStatusSchema,
} from "@aura/contracts/api/account";
import { encodeId } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { listOwnAuditEntries, setDeletionRequested } from "./account-queries.ts";
import type { ProviderName } from "./oauth-providers.ts";
import { listOwnIdentities } from "./oauth-queries.ts";
import { listMyOrgs } from "./org-queries.ts";
import { listOwnPasskeys } from "./passkey-queries.ts";
import { getMe, listDevices, revokeAllOwnSessions } from "./queries.ts";
import { serializeClearedCookie } from "./rules.ts";
import { userAudit } from "./sign-in.ts";

export interface AccountRouteDeps {
    readonly clock: Clock;
    readonly emailEnabled: boolean;
    readonly oauthProviders: readonly ProviderName[];
    readonly secureCookies: boolean;
}

// Account-level routes: which sign-in methods exist, the personal data export, and the deletion
// request (Stage 1 plan assumption 6: the request is recorded and sessions end; the purge is Stage 3).
export function accountRoutes(deps: AccountRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/auth/methods", (c) =>
        c.json(
            authMethodsResponseSchema.parse({
                email: deps.emailEnabled,
                passkey: true,
                oauth: deps.oauthProviders,
            }),
        ),
    );
    routes.get("/me/status", (c) =>
        c.json(sessionStatusSchema.parse({ signed_in: c.get("actor").kind === "user" })),
    );
    routes.get("/me/export", (c) => handleExport(c, deps));
    routes.post("/me/delete-request", (c) => handleRequestDeletion(c, deps));
    routes.delete("/me/delete-request", (c) => handleCancelDeletion(c));
    return routes;
}

const unauthenticated = (c: Context<AppEnv>) =>
    problemResponse(c, "unauthenticated", "Authentication required");

const iso = (date: Date | null) => (date === null ? null : date.toISOString());

async function handleExport(c: Context<AppEnv>, deps: AccountRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind !== "user") return unauthenticated(c);
    const tx = c.get("tx");
    const nowMs = deps.clock.nowUnixMs();
    const me = await getMe(tx, actor.userId);
    if (me === null) return problemResponse(c, "not_found", "Not found");
    const [orgs, passkeys, identities, devices, audit] = [
        await listMyOrgs(tx, actor.userId),
        await listOwnPasskeys(tx),
        await listOwnIdentities(tx),
        await listDevices(tx, actor.userId, nowMs),
        await listOwnAuditEntries(tx, actor.userId),
    ];
    const body = exportSchema.parse({
        exported_at: new Date(nowMs).toISOString(),
        account: {
            id: encodeId("usr", me.id),
            email: me.email,
            email_verified: me.email_verified_at !== null,
            handle: me.handle,
            display_name: me.display_name,
            created_at: me.created_at.toISOString(),
            deletion_requested_at: iso(me.deletion_requested_at),
        },
        organizations: orgs.map((org) => ({
            id: encodeId("org", org.id),
            slug: org.slug,
            name: org.name,
            kind: org.kind,
            role: org.role,
            joined_at: org.created_at.toISOString(),
        })),
        passkeys: passkeys.map((p) => ({
            name: p.name,
            created_at: p.created_at.toISOString(),
            last_used_at: iso(p.last_used_at),
        })),
        identities: identities.map((i) => ({
            provider: i.provider,
            created_at: i.created_at.toISOString(),
            last_login_at: iso(i.last_login_at),
        })),
        sessions: devices.map((d) => ({
            auth_method: d.auth_method,
            created_at: d.created_at.toISOString(),
            last_seen_at: d.last_seen_at.toISOString(),
            ip_network: d.ip_network,
            user_agent: d.user_agent,
        })),
        audit: audit.map((a) => ({ at: a.at.toISOString(), action: a.action, target: a.target })),
    });
    await appendAudit(tx, userAudit(actor.userId, "account.exported", null));
    c.header("Content-Disposition", 'attachment; filename="auraland-export.json"');
    return c.json(body);
}

async function handleRequestDeletion(c: Context<AppEnv>, deps: AccountRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind !== "user") return unauthenticated(c);
    const tx = c.get("tx");
    const nowMs = deps.clock.nowUnixMs();
    await setDeletionRequested(tx, actor.userId, nowMs);
    await appendAudit(tx, userAudit(actor.userId, "account.deletion_requested", null));
    // Every session ends, this one included, so the request is the last thing this browser does.
    await revokeAllOwnSessions(tx, actor.userId, nowMs, "logout_all");
    c.header("Set-Cookie", serializeClearedCookie(deps.secureCookies));
    return c.json(
        deletionRequestResponseSchema.parse({
            deletion_requested_at: new Date(nowMs).toISOString(),
        }),
        202,
    );
}

async function handleCancelDeletion(c: Context<AppEnv>) {
    const actor = c.get("actor");
    if (actor.kind !== "user") return unauthenticated(c);
    const tx = c.get("tx");
    await setDeletionRequested(tx, actor.userId, null);
    await appendAudit(tx, userAudit(actor.userId, "account.deletion_cancelled", null));
    return c.body(null, 204);
}
