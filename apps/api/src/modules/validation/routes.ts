import { validationReportResponseSchema } from "@aura/contracts/api/validation";
import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { validationCheckSchema } from "@aura/contracts/validation";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import { problemResponse } from "../../platform/problem-response.ts";

// The latest validation report of a version, for the people who work on its task. Row-level security
// (migration 0026) decides who can see reports at all; anyone else gets "no report", the same answer
// as for a version that was never validated.
export function validationRoutes(): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/task-versions/:id/validation", (c) => handleLatest(c));
    return routes;
}

const rowSchema = z.object({
    id: z.string(),
    task_version_id: z.string(),
    attestation: z.enum(["development", "production"]),
    passed: z.boolean(),
    score: z.coerce.number().nullable(),
    score_version: z.number().int().nullable(),
    checks: z.array(validationCheckSchema),
    created_at: z.date(),
});

async function handleLatest(c: Context<AppEnv>) {
    if (c.get("actor").kind !== "user") {
        return problemResponse(c, "unauthenticated", "Authentication required");
    }
    const parsed = idSchema("tsv").safeParse(c.req.param("id"));
    if (!parsed.success) return problemResponse(c, "invalid_request", "Invalid request");
    const versionId = decodeId("tsv", parsed.data);
    const tx = c.get("tx");
    // A version the caller cannot see does not exist for them; one they can see but may not read
    // reports of (a plain member of a released task) simply has no report to show.
    if ((await tx`select 1 from task_versions where id = ${versionId}`).length === 0) {
        return problemResponse(c, "not_found", "Not found");
    }
    const rows = await tx`
        select id, task_version_id, attestation, passed, score, score_version, checks, created_at
        from validation_reports where task_version_id = ${versionId}
        order by created_at desc, id desc limit 1`;
    const row = rows[0] === undefined ? null : rowSchema.parse(rows[0]);
    return c.json(
        validationReportResponseSchema.parse({
            report:
                row === null
                    ? null
                    : {
                          id: encodeId("vrp", row.id),
                          task_version_id: encodeId("tsv", row.task_version_id),
                          attestation: row.attestation,
                          passed: row.passed,
                          score: row.score,
                          score_version: row.score_version,
                          checks: row.checks,
                          created_at: row.created_at.toISOString(),
                      },
        }),
    );
}
