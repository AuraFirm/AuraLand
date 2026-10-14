import {
    attackCreateRequestSchema,
    attackSchema,
    attacksResponseSchema,
} from "@aura/contracts/api/attacks";
import { encodeId } from "@aura/contracts/ids";
import { ATTACKS_PER_MINUTE_PER_USER_MAX } from "@aura/contracts/limits";
import { appendAudit } from "@aura/db/audit";
import { CHECK_VIOLATION, postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { RateLimitRule } from "../../platform/rate-limit.ts";
import {
    consumeRateLimit,
    type RateLimitDeps,
    refuseRateLimited,
} from "../../rate-limit-middleware.ts";
import { type AttackRow, insertAttack, listAttacks } from "./attack-queries.ts";
import { caller, invalid, notFound, readJson, unauthenticated } from "./route-support.ts";
import { getVersion } from "./version-queries.ts";
import { versionIdParam } from "./version-routes.ts";

export type AttackRouteDeps = Pick<RateLimitDeps, "sql" | "clock" | "key">;

const ATTACK_BY_USER: RateLimitRule = {
    name: "attack:user",
    max: ATTACKS_PER_MINUTE_PER_USER_MAX,
    windowS: 60,
};

// Who may attack and who may read is decided by row-level security and the guard trigger of
// migration 0030; this route turns their refusals into answers. A version the person cannot see is a
// plain 404.
export function attackRoutes(deps: AttackRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/task-versions/:id/attacks", handleList);
    routes.post("/task-versions/:id/attacks", (c) => handleCreate(c, deps));
    return routes;
}

const attackBody = (row: AttackRow) =>
    attackSchema.parse({
        id: encodeId("atk", row.id),
        author_id: encodeId("usr", row.author_id),
        outcome: row.outcome,
        method: row.method,
        created_at: row.created_at.toISOString(),
    });

async function handleList(c: Context<AppEnv>) {
    if (caller(c) === null) return unauthenticated(c);
    const versionId = versionIdParam(c);
    if (versionId === null) return invalid(c);
    const tx = c.get("tx");
    if ((await getVersion(tx, versionId)) === null) return notFound(c);
    return c.json(
        attacksResponseSchema.parse({
            attacks: (await listAttacks(tx, versionId)).map(attackBody),
        }),
    );
}

async function handleCreate(c: Context<AppEnv>, deps: AttackRouteDeps) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const versionId = versionIdParam(c);
    const request = attackCreateRequestSchema.safeParse(await readJson(c));
    if (versionId === null || !request.success) return invalid(c);
    const tx = c.get("tx");
    const version = await getVersion(tx, versionId);
    if (version === null) return notFound(c);
    const verdict = await consumeRateLimit(deps, ATTACK_BY_USER, who.userId);
    if (!verdict.allowed) return refuseRateLimited(c, verdict);
    try {
        const row = await insertAttack(tx, {
            orgId: version.org_id,
            versionId,
            authorId: who.userId,
            outcome: request.data.outcome,
            method: request.data.method,
            nowMs: deps.clock.nowUnixMs(),
        });
        await appendAudit(tx, {
            actorKind: "user",
            actorUserId: who.userId,
            orgId: version.org_id,
            action: "version.attacked",
            target: encodeId("tsv", versionId),
            detail: { finding: encodeId("atk", row.id), outcome: row.outcome },
        });
        return c.json(attackBody(row), 201);
    } catch (error) {
        const code = postgresErrorCode(error);
        // The guard trigger: the author's own version, or a version not in a state worth attacking.
        if (code === CHECK_VIOLATION)
            return problemResponse(c, "conflict", "This version cannot be attacked by you now");
        // Row-level security: the person may see the version but may not attack it.
        if (code === "42501") return problemResponse(c, "forbidden", "Forbidden");
        throw error;
    }
}
