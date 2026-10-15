import { createHash } from "node:crypto";
import {
    createShareRequestSchema,
    createShareResponseSchema,
    myCredentialsResponseSchema,
    setVisibilityRequestSchema,
} from "@aura/contracts/api/passport";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { CHECK_VIOLATION, postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { Rng } from "../../platform/rng.ts";
import * as q from "./holder-queries.ts";

export interface HolderRouteDeps {
    readonly clock: Clock;
    readonly rng: Rng;
    readonly publicOrigin: string;
}

const NO_DATA_FOUND = "P0002";
const PROGRAM_LIMIT_EXCEEDED = "54000";
const SHARE_SECRET_BYTES = 32;

// A person's own Passport: their credentials, who may see each, and links. Everything is about the signed-in person;
// there is no way to name another person's credential (the functions check ownership, and a stranger's id is a 404).
export function holderRoutes(deps: HolderRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/me/credentials", handleList);
    routes.put("/credentials/:id/visibility", (c) => handleVisibility(c, deps));
    routes.post("/credentials/:id/shares", (c) => handleCreateShare(c, deps));
    routes.delete("/credentials/:id/shares/:share_id", (c) => handleRevokeShare(c, deps));
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");
const invalid = (c: Context<AppEnv>) => problemResponse(c, "invalid_request", "Invalid request");

function caller(c: Context<AppEnv>) {
    const actor = c.get("actor");
    if (actor.kind !== "user")
        return { problem: problemResponse(c, "unauthenticated", "Authentication required") };
    return { actor };
}

function translated(c: Context<AppEnv>, error: unknown) {
    const code = postgresErrorCode(error);
    if (code === NO_DATA_FOUND) return notFound(c);
    if (code === CHECK_VIOLATION) return invalid(c);
    if (code === PROGRAM_LIMIT_EXCEEDED)
        return problemResponse(c, "conflict", "Conflict", "five links are live already");
    throw error;
}

async function handleList(c: Context<AppEnv>) {
    const who = caller(c);
    if ("problem" in who) return who.problem;
    const tx = c.get("tx");
    const [credentials, shares] = [await q.ownCredentials(tx), await q.ownShares(tx)];
    return c.json(
        myCredentialsResponseSchema.parse({
            credentials: credentials.map((row) => ({
                id: encodeId("crd", row.id),
                kind: row.kind,
                name: row.claim.event_title,
                assurance_level: row.assurance_level,
                issued_at: row.issued_at.toISOString(),
                expires_at: row.expires_at?.toISOString() ?? null,
                revoked: row.revoked_at !== null,
                visibility: row.visibility,
                shares: shares
                    .filter((share) => share.credential_id === row.id)
                    .map((share) => ({
                        id: encodeId("shr", share.id),
                        expires_at: share.expires_at.toISOString(),
                        revoked: share.revoked_at !== null,
                    })),
            })),
        }),
    );
}

async function handleVisibility(c: Context<AppEnv>, _deps: HolderRouteDeps) {
    const who = caller(c);
    if ("problem" in who) return who.problem;
    const id = idSchema("crd").safeParse(c.req.param("id"));
    const body = setVisibilityRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) return invalid(c);
    const tx = c.get("tx");
    try {
        await q.setVisibility(tx, decodeId("crd", id.data), body.data.visibility);
    } catch (error) {
        return translated(c, error);
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: who.actor.userId,
        orgId: null,
        action: "passport.visibility_changed",
        target: id.data,
        detail: { visibility: body.data.visibility },
    });
    return c.body(null, 204);
}

async function handleCreateShare(c: Context<AppEnv>, deps: HolderRouteDeps) {
    const who = caller(c);
    if ("problem" in who) return who.problem;
    const id = idSchema("crd").safeParse(c.req.param("id"));
    const body = createShareRequestSchema.safeParse((await c.req.json().catch(() => ({}))) ?? {});
    if (!id.success || !body.success) return invalid(c);
    const secret = Buffer.from(deps.rng.nextBytes(SHARE_SECRET_BYTES)).toString("base64url");
    const tx = c.get("tx");
    try {
        const share = await q.createShare(tx, {
            credential: decodeId("crd", id.data),
            tokenHash: createHash("sha256").update(secret).digest(),
            days: body.data.days,
            nowMs: deps.clock.nowUnixMs(),
        });
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: who.actor.userId,
            orgId: null,
            action: "passport.share_created",
            target: id.data,
            detail: { days: body.data.days },
        });
        return c.json(
            createShareResponseSchema.parse({
                share_id: encodeId("shr", share.id),
                url: `${deps.publicOrigin}/verify/${id.data}?s=${secret}`,
                expires_at: share.expiresAt.toISOString(),
            }),
            201,
        );
    } catch (error) {
        return translated(c, error);
    }
}

async function handleRevokeShare(c: Context<AppEnv>, deps: HolderRouteDeps) {
    const who = caller(c);
    if ("problem" in who) return who.problem;
    const credential = idSchema("crd").safeParse(c.req.param("id"));
    const share = idSchema("shr").safeParse(c.req.param("share_id"));
    if (!credential.success || !share.success) return invalid(c);
    const tx = c.get("tx");
    try {
        await q.revokeShare(tx, decodeId("shr", share.data), deps.clock.nowUnixMs());
    } catch (error) {
        return translated(c, error);
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: who.actor.userId,
        orgId: null,
        action: "passport.share_revoked",
        target: share.data,
        detail: {},
    });
    return c.body(null, 204);
}
