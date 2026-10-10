import {
    passkeyAddedResponseSchema,
    passkeyLoginRequestSchema,
    passkeyLoginResponseSchema,
    passkeyOptionsResponseSchema,
    passkeyRegisterRequestSchema,
    passkeyRenameRequestSchema,
    passkeySchema,
    passkeysResponseSchema,
} from "@aura/contracts/api/passkeys";
import { encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import type { Sql } from "@aura/db/client";
import { withRequestContext } from "@aura/db/context";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import { ipNetwork } from "../../platform/client-address.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { Rng } from "../../platform/rng.ts";
import { clientAddress, userAgentOf } from "../../request-info.ts";
import { hasFreshStepUp } from "./authorize.ts";
import {
    beginLogin,
    beginRegistration,
    beginStepUp,
    finishLogin,
    finishRegistration,
    finishStepUp,
    type IssuedOptions,
    type PasskeyDeps,
} from "./passkey.ts";
import { deleteOwnPasskey, listOwnPasskeys, renameOwnPasskey } from "./passkey-queries.ts";
import { createPgSessionStore } from "./queries.ts";
import { serializeSessionCookie } from "./rules.ts";
import { userAudit } from "./sign-in.ts";

export interface PasskeyRouteDeps {
    readonly sql: Sql;
    readonly clock: Clock;
    readonly rng: Rng;
    readonly rpId: string;
    readonly rpName: string;
    readonly origin: string;
    readonly secureCookies: boolean;
    readonly trustEdge: boolean;
}

const IDENTITY_CONTEXT = {
    role: "aura_auth",
    actorKind: "anonymous",
    userId: null,
    orgIds: [],
} as const;
const DEFAULT_PASSKEY_NAME = "Passkey";
const REFUSED = "That did not work. Try again";

// Passkey routes. The ceremony routes under /auth/passkey run their own `aura_auth` transactions
// (see sign-in-routes.ts for why); the /me routes use the request transaction as the signed-in person.
export function passkeyRoutes(deps: PasskeyRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    const ceremony: PasskeyDeps = {
        clock: deps.clock,
        rng: deps.rng,
        rpId: deps.rpId,
        rpName: deps.rpName,
        origin: deps.origin,
    };
    routes.post("/auth/passkey/register/options", (c) => registerOptions(c, deps, ceremony));
    routes.post("/auth/passkey/register/verify", (c) => registerVerify(c, deps, ceremony));
    routes.post("/auth/passkey/step-up/options", (c) => stepUpOptions(c, deps, ceremony));
    routes.post("/auth/passkey/step-up/verify", (c) => stepUpVerify(c, deps, ceremony));
    routes.post("/auth/passkey/login/options", (c) => loginOptions(c, deps, ceremony));
    routes.post("/auth/passkey/login/verify", (c) => loginVerify(c, deps, ceremony));
    routes.get("/me/passkeys", listPasskeys);
    routes.patch("/me/passkeys/:id", renamePasskey);
    routes.delete("/me/passkeys/:id", (c) => removePasskey(c, deps));
    return routes;
}

const readJson = (c: Context<AppEnv>): Promise<unknown> =>
    c.req.json().then(
        (body: unknown) => body,
        () => null,
    );

const optionsBody = (issued: IssuedOptions) =>
    passkeyOptionsResponseSchema.parse({
        challenge_id: issued.challengeId,
        options: issued.options,
    });

function sessionIdOf(c: Context<AppEnv>): string {
    const actor = c.get("actor");
    if (actor.kind !== "user") throw new Error("only a signed-in person has a session");
    return actor.sessionId;
}

async function stepUpOptions(c: Context<AppEnv>, deps: PasskeyRouteDeps, ceremony: PasskeyDeps) {
    const userId = signedInUserId(c);
    if (userId === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const issued = await withRequestContext(deps.sql, IDENTITY_CONTEXT, (tx) =>
        beginStepUp(tx, ceremony, userId),
    );
    // A person with no passkey cannot step up; they register one first.
    if (issued === null) return problemResponse(c, "conflict", "Add a passkey first");
    return c.json(optionsBody(issued));
}

async function stepUpVerify(c: Context<AppEnv>, deps: PasskeyRouteDeps, ceremony: PasskeyDeps) {
    const userId = signedInUserId(c);
    if (userId === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const parsed = passkeyLoginRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return problemResponse(c, "invalid_request", REFUSED);
    const ok = await withRequestContext(deps.sql, IDENTITY_CONTEXT, (tx) =>
        finishStepUp(tx, ceremony, {
            userId,
            sessionId: sessionIdOf(c),
            challengeId: parsed.data.challenge_id,
            credential: parsed.data.credential,
        }),
    );
    return ok ? c.body(null, 204) : problemResponse(c, "invalid_request", REFUSED);
}

function signedInUserId(c: Context<AppEnv>): string | null {
    const actor = c.get("actor");
    return actor.kind === "user" ? actor.userId : null;
}

async function registerOptions(c: Context<AppEnv>, deps: PasskeyRouteDeps, ceremony: PasskeyDeps) {
    const userId = signedInUserId(c);
    if (userId === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const begun = await withRequestContext(deps.sql, IDENTITY_CONTEXT, (tx) =>
        beginRegistration(tx, ceremony, userId),
    );
    if (!begun.ok) return problemResponse(c, "conflict", "You have reached the passkey limit");
    return c.json(optionsBody(begun.issued));
}

async function registerVerify(c: Context<AppEnv>, deps: PasskeyRouteDeps, ceremony: PasskeyDeps) {
    const userId = signedInUserId(c);
    if (userId === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const parsed = passkeyRegisterRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return problemResponse(c, "invalid_request", REFUSED);
    const name = parsed.data.name ?? DEFAULT_PASSKEY_NAME;
    const ip = clientAddress(c, deps.trustEdge);
    const finished = await withRequestContext(deps.sql, IDENTITY_CONTEXT, (tx) =>
        finishRegistration(tx, ceremony, {
            userId,
            challengeId: parsed.data.challenge_id,
            credential: parsed.data.credential,
            name,
            ip,
            sessionId: sessionIdOf(c),
        }),
    );
    if (!finished.ok) return problemResponse(c, "invalid_request", REFUSED);
    return c.json(
        passkeyAddedResponseSchema.parse({ id: encodeId("pky", finished.passkeyId), name }),
        201,
    );
}

async function loginOptions(c: Context<AppEnv>, deps: PasskeyRouteDeps, ceremony: PasskeyDeps) {
    const issued = await withRequestContext(deps.sql, IDENTITY_CONTEXT, (tx) =>
        beginLogin(tx, ceremony),
    );
    return c.json(optionsBody(issued));
}

async function loginVerify(c: Context<AppEnv>, deps: PasskeyRouteDeps, ceremony: PasskeyDeps) {
    const parsed = passkeyLoginRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return problemResponse(c, "invalid_request", REFUSED);
    const address = clientAddress(c, deps.trustEdge);
    const actor = c.get("actor");
    const outcome = await withRequestContext(deps.sql, IDENTITY_CONTEXT, (tx) =>
        finishLogin(
            tx,
            ceremony,
            { store: createPgSessionStore(tx), clock: deps.clock, rng: deps.rng },
            {
                challengeId: parsed.data.challenge_id,
                credential: parsed.data.credential,
                session: {
                    ipNetwork: address === null ? null : ipNetwork(address),
                    ip: address,
                    userAgent: userAgentOf(c),
                    previousSessionId: actor.kind === "user" ? actor.sessionId : null,
                },
            },
        ),
    );
    if (!outcome.ok) return problemResponse(c, "invalid_request", REFUSED);
    // The new session replaces any "clear the old cookie" that authenticate queued.
    c.set("clearSessionCookie", false);
    c.header("Set-Cookie", serializeSessionCookie(outcome.token, deps.secureCookies));
    return c.json(passkeyLoginResponseSchema.parse({ status: "signed_in" }));
}

async function listPasskeys(c: Context<AppEnv>) {
    if (signedInUserId(c) === null)
        return problemResponse(c, "unauthenticated", "Authentication required");
    const rows = await listOwnPasskeys(c.get("tx"));
    const items = rows.map((row) =>
        passkeySchema.parse({
            id: encodeId("pky", row.id),
            name: row.name,
            created_at: row.created_at.toISOString(),
            last_used_at: row.last_used_at === null ? null : row.last_used_at.toISOString(),
            transports: row.transports,
            device_type: row.device_type,
            backed_up: row.backed_up,
        }),
    );
    return c.json(passkeysResponseSchema.parse({ items }));
}

async function renamePasskey(c: Context<AppEnv>) {
    const userId = signedInUserId(c);
    if (userId === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const id = idSchema("pky").safeParse(c.req.param("id"));
    const body = passkeyRenameRequestSchema.safeParse(await readJson(c));
    if (!id.success || !body.success)
        return problemResponse(c, "invalid_request", "Invalid request");
    const changed = await renameOwnPasskey(
        c.get("tx"),
        id.data.slice("pky_".length),
        body.data.name,
    );
    if (!changed) return problemResponse(c, "not_found", "Not found");
    return c.body(null, 204);
}

// Removing a passkey changes how the person proves who they are (ASVS V7.5.1), so it needs a fresh
// passkey check, which the passkey being removed can itself provide.
async function removePasskey(c: Context<AppEnv>, deps: PasskeyRouteDeps) {
    const userId = signedInUserId(c);
    if (userId === null) return problemResponse(c, "unauthenticated", "Authentication required");
    const actor = c.get("actor");
    const stepUpAtMs = actor.kind === "user" ? actor.stepUpAtMs : null;
    if (!hasFreshStepUp(stepUpAtMs, deps.clock.nowUnixMs())) {
        return problemResponse(c, "step_up_required", "Confirm with your passkey to continue");
    }
    const id = idSchema("pky").safeParse(c.req.param("id"));
    if (!id.success) return problemResponse(c, "invalid_request", "Invalid passkey id");
    const tx = c.get("tx");
    if (!(await deleteOwnPasskey(tx, id.data.slice("pky_".length)))) {
        return problemResponse(c, "not_found", "Not found");
    }
    await appendAudit(tx, { ...userAudit(userId, "auth.passkey_removed", null), target: id.data });
    return c.body(null, 204);
}
