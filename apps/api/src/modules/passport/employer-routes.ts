import {
    credentialViewsResponseSchema,
    employerPurposeSchema,
    employerReportSchema,
    employerSearchResponseSchema,
} from "@aura/contracts/api/passport";
import { type CredentialClaim, credentialKindSchema } from "@aura/contracts/credentials";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import { CHECK_VIOLATION, postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { hasFreshStepUp } from "../../platform/step-up.ts";
import * as q from "./employer-queries.ts";
import { publishedKeys } from "./publish.ts";
import { verifyCredentialJwt } from "./verify.ts";

export interface EmployerRouteDeps {
    readonly clock: Clock;
}

const NO_DATA_FOUND = "P0002";
const SEARCH_PAGE = 50;

// Employers (Stage 7, slice 9). Approval is a platform administrator's act; everything else needs a member of an
// approved employer organization with a fresh passkey check. The database decides who is an employer; these routes
// translate, require the second factor, and write the audit trail. A stranger to the feature gets a 404.
export function employerRoutes(deps: EmployerRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.put("/admin/employers/:org_id", (c) => handleApprove(c, deps, true));
    routes.delete("/admin/employers/:org_id", (c) => handleApprove(c, deps, false));
    routes.get("/employer/credentials", (c) => handleSearch(c, deps));
    routes.get("/employer/reports/:credential_id", (c) => handleReport(c, deps));
    routes.get("/credentials/:id/views", handleViews);
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");
const invalid = (c: Context<AppEnv>) => problemResponse(c, "invalid_request", "Invalid request");

function secondFactor(c: Context<AppEnv>, deps: EmployerRouteDeps) {
    const actor = c.get("actor");
    if (actor.kind === "anonymous")
        return { problem: problemResponse(c, "unauthenticated", "Authentication required") };
    if (actor.kind !== "user") return { problem: notFound(c) };
    if (!hasFreshStepUp(actor.stepUpAtMs, deps.clock.nowUnixMs())) {
        return {
            problem: problemResponse(
                c,
                "step_up_required",
                "Confirm with your passkey to continue",
            ),
        };
    }
    return { actor };
}

function translated(c: Context<AppEnv>, error: unknown) {
    const code = postgresErrorCode(error);
    if (code === NO_DATA_FOUND || code === "42501") return notFound(c);
    if (code === CHECK_VIOLATION) return invalid(c);
    throw error;
}

async function handleApprove(c: Context<AppEnv>, deps: EmployerRouteDeps, approve: boolean) {
    const gate = secondFactor(c, deps);
    if ("problem" in gate) return gate.problem;
    if (gate.actor.platformRole !== "admin") return notFound(c);
    const org = idSchema("org").safeParse(c.req.param("org_id"));
    if (!org.success) return invalid(c);
    const tx = c.get("tx");
    try {
        const change = approve ? q.approve : q.revoke;
        await change(tx, decodeId("org", org.data), deps.clock.nowUnixMs());
    } catch (error) {
        return translated(c, error);
    }
    await appendAudit(tx, {
        actorKind: "user",
        actorUserId: gate.actor.userId,
        orgId: null,
        action: approve ? "passport.employer_approved" : "passport.employer_revoked",
        target: org.data,
        detail: {},
    });
    return c.body(null, 204);
}

const searchQuery = z
    .object({
        org_id: idSchema("org"),
        kind: credentialKindSchema.optional(),
        after: idSchema("crd").optional(),
    })
    .strict();

async function handleSearch(c: Context<AppEnv>, deps: EmployerRouteDeps) {
    const gate = secondFactor(c, deps);
    if ("problem" in gate) return gate.problem;
    const query = searchQuery.safeParse(c.req.query());
    if (!query.success) return invalid(c);
    try {
        const rows = await q.search(c.get("tx"), {
            org: decodeId("org", query.data.org_id),
            kind: query.data.kind ?? null,
            after: query.data.after === undefined ? null : decodeId("crd", query.data.after),
            limit: SEARCH_PAGE + 1,
        });
        const page = rows.slice(0, SEARCH_PAGE);
        const last = page[page.length - 1];
        return c.json(
            employerSearchResponseSchema.parse({
                credentials: page.map((row) => ({
                    id: encodeId("crd", row.id),
                    kind: row.kind,
                    name: row.claim.event_title,
                    assurance_level: row.assurance_level,
                    issued_at: row.issued_at.toISOString(),
                    expires_at: row.expires_at?.toISOString() ?? null,
                })),
                next_after:
                    rows.length > SEARCH_PAGE && last !== undefined
                        ? encodeId("crd", last.id)
                        : null,
            }),
        );
    } catch (error) {
        return translated(c, error);
    }
}

const reportQuery = z.object({ org_id: idSchema("org"), purpose: employerPurposeSchema }).strict();

// What a reader should take from the claim, in words; never more than the claim holds.
function summaryOf(claim: CredentialClaim): string[] {
    if (claim.kind === "contest_rank") {
        return [
            `Rank ${claim.rank} of ${claim.participants}`,
            `Solved ${claim.solved} problem${claim.solved === 1 ? "" : "s"}`,
            `Hosted by ${claim.host_name}`,
        ];
    }
    return [
        `Scored ${claim.points_band} percent of the points`,
        claim.ai_mode === "ai_free" ? "Without AI assistance" : "AI assistance allowed and logged",
        `Hosted by ${claim.host_name}`,
    ];
}

async function handleReport(c: Context<AppEnv>, deps: EmployerRouteDeps) {
    const gate = secondFactor(c, deps);
    if ("problem" in gate) return gate.problem;
    const credential = idSchema("crd").safeParse(c.req.param("credential_id"));
    const query = reportQuery.safeParse(c.req.query());
    if (!credential.success || !query.success) return invalid(c);
    const tx = c.get("tx");
    const nowMs = deps.clock.nowUnixMs();
    try {
        const row = await q.report(tx, {
            org: decodeId("org", query.data.org_id),
            credential: decodeId("crd", credential.data),
            purpose: query.data.purpose,
            nowMs,
        });
        const verified = await verifyCredentialJwt(row.vc_jwt, await publishedKeys(tx), nowMs);
        const outcome =
            verified.outcome === "invalid"
                ? "invalid"
                : row.revoked_at !== null
                  ? "revoked"
                  : verified.outcome;
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: gate.actor.userId,
            orgId: null,
            action: "passport.report_opened",
            target: credential.data,
            detail: { purpose: query.data.purpose },
        });
        return c.json(
            employerReportSchema.parse({
                id: credential.data,
                outcome,
                ...(verified.outcome === "invalid" ? { reason: verified.reason } : {}),
                name: row.claim.event_title,
                issuer: verified.outcome === "invalid" ? "" : verified.issuerName,
                kind: row.kind,
                assurance_level: row.assurance_level,
                environment: verified.outcome === "invalid" ? "development" : verified.environment,
                summary: summaryOf(row.claim),
                issued_at: row.issued_at.toISOString(),
                expires_at: row.expires_at?.toISOString() ?? null,
                logged: true,
            }),
        );
    } catch (error) {
        return translated(c, error);
    }
}

async function handleViews(c: Context<AppEnv>) {
    if (c.get("actor").kind !== "user")
        return problemResponse(c, "unauthenticated", "Authentication required");
    const id = idSchema("crd").safeParse(c.req.param("id"));
    if (!id.success) return invalid(c);
    const tx = c.get("tx");
    // Someone else's credential, or none, is the same 404: the holder's own policy decides what can be seen.
    const mine =
        await tx`select 1 as one from credentials where id = ${decodeId("crd", id.data)} and subject_user_id = app_user()`;
    if (mine.length === 0) return notFound(c);
    const rows = await q.ownViews(tx, decodeId("crd", id.data));
    return c.json(
        credentialViewsResponseSchema.parse({
            views: rows.map((row) => ({
                org_name: row.org_name,
                purpose: row.purpose,
                viewed_at: row.viewed_at.toISOString(),
            })),
        }),
    );
}
