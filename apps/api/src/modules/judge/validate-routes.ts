import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { jobAcceptedSchema, validationLeaseResponseSchema } from "@aura/contracts/judge-protocol";
import { LEASE_POLL_MS } from "@aura/contracts/limits";
import { validationCompleteRequestSchema } from "@aura/contracts/validation";
import { appendAudit } from "@aura/db/audit";
import { withRequestContext } from "@aura/db/context";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import {
    completeJob,
    failJob,
    getJob,
    jobDepsFor,
    LEASE_TTL_MS,
    leaseJob,
} from "../jobs/service.ts";
import {
    evaluateValidation,
    readValidationWork,
    settleValidation,
    type ValidationWork,
} from "../validation/service.ts";
import type { JudgeRouteDeps } from "./routes.ts";

// The node side of task validation (Stage 4B): leasing a validate job and reporting what was seen.
// The node reports raw observations; evaluateValidation draws every conclusion (rules.ts).

type Tx = Parameters<Parameters<typeof withRequestContext>[2]>[0];
export const VALIDATE_KIND = "task.validate";
export const payloadSchema = z.object({ task_version_id: z.string() });
const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;
const inTransaction = <T>(
    deps: JudgeRouteDeps,
    work: Parameters<typeof withRequestContext<T>>[2],
) => withRequestContext(deps.sql, WORKER, work);

const hasInputs = (work: ValidationWork) =>
    work.spec !== null && work.bundle_sha256 !== null && work.bundle_bytes !== null;

// Leases the next validate job. A job whose version is no longer validating (settled elsewhere,
// abandoned) is closed without bothering a node.
async function leaseOne(tx: Tx, deps: JudgeRouteDeps, nodeId: string) {
    const queue = jobDepsFor(tx, deps.clock, deps.rng);
    const job = await leaseJob(queue, "validate", nodeId);
    if (job === null) return null;
    const payload = payloadSchema.safeParse(job.payload);
    const work = payload.success
        ? await readValidationWork(tx, payload.data.task_version_id)
        : null;
    if (work === null || work.state !== "validating" || !hasInputs(work)) {
        await completeJob(queue, job.id, job.leaseEpoch, { skipped: true });
        return "skipped" as const;
    }
    return {
        job_id: encodeId("job", job.id),
        lease_epoch: job.leaseEpoch,
        lease_ttl_s: LEASE_TTL_MS / 1000,
        kind: VALIDATE_KIND,
        task: {
            version_id: encodeId("tsv", work.id),
            bundle: {
                sha256: Buffer.from(work.bundle_sha256 ?? []).toString("hex"),
                bytes: work.bundle_bytes ?? 0,
            },
            spec: work.spec,
        },
    };
}

export async function handleValidationLease(
    c: Context<AppEnv>,
    deps: JudgeRouteDeps,
    waitMs: number,
) {
    const nodeId = c.get("nodeId");
    const looks = Math.floor(waitMs / LEASE_POLL_MS) + 1;
    for (let look = 0; look < looks; look++) {
        const job = await inTransaction(deps, (tx) => leaseOne(tx, deps, nodeId));
        if (job === "skipped") {
            look--; // a stale job was closed; ask again at once
            continue;
        }
        if (job !== null) return c.json(validationLeaseResponseSchema.parse({ job }));
        if (look < looks - 1) await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
    }
    return c.json(validationLeaseResponseSchema.parse({ job: null }));
}

class LeaseLostError extends Error {}

// Reports what a node saw. A report that cannot be true sends the job to another node; a true one
// becomes an immutable report and moves the version, in one transaction.
export async function handleValidationComplete(c: Context<AppEnv>, deps: JudgeRouteDeps) {
    const jobParsed = idSchema("job").safeParse(c.req.param("id"));
    const body = validationCompleteRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!jobParsed.success || !body.success) {
        return problemResponse(c, "invalid_request", "Invalid request");
    }
    const jobId = decodeId("job", jobParsed.data);
    const nodeId = c.get("nodeId");
    const outcome = await inTransaction(deps, (tx) =>
        settle(tx, deps, nodeId, jobId, body.data),
    ).catch((error: unknown) => {
        if (error instanceof LeaseLostError) return "stale" as const;
        throw error;
    });
    if (outcome === "stale") {
        return problemResponse(c, "conflict", "The lease is no longer yours");
    }
    if (outcome === "rejected") {
        return problemResponse(c, "invalid_request", "The result was not accepted");
    }
    return c.json(jobAcceptedSchema.parse({ accepted: true }));
}

async function settle(
    tx: Tx,
    deps: JudgeRouteDeps,
    nodeId: string,
    jobId: string,
    body: z.infer<typeof validationCompleteRequestSchema>,
) {
    const queue = jobDepsFor(tx, deps.clock, deps.rng);
    const job = await getJob(queue, jobId);
    const mine =
        job !== null &&
        job.kind === VALIDATE_KIND &&
        job.state === "leased" &&
        job.leaseOwner === nodeId &&
        job.leaseEpoch === body.lease_epoch;
    if (!mine) return "stale" as const;
    const work = await readValidationWork(tx, payloadSchema.parse(job.payload).task_version_id);
    if (work === null || work.state !== "validating" || work.spec === null) return "stale" as const;
    const evaluation = evaluateValidation(
        work.spec.tests.map((test) => test.id),
        body.result,
    );
    if (!evaluation.ok) {
        await failJob(queue, {
            id: jobId,
            epoch: body.lease_epoch,
            error: evaluation.reason,
            retryable: true,
        });
        return "rejected" as const;
    }
    // The job is closed first so a lost lease aborts everything; then the report and the move.
    if (
        !(await completeJob(queue, jobId, body.lease_epoch, { checks: evaluation.checks.length }))
    ) {
        throw new LeaseLostError();
    }
    const report = await settleValidation(tx, {
        versionId: work.id,
        nodeId,
        checks: evaluation.checks,
        observations: body.result,
        nowMs: deps.clock.nowUnixMs(),
    });
    if (report === null) throw new LeaseLostError();
    await appendAudit(tx, {
        actorKind: "worker",
        actorUserId: null,
        orgId: work.org_id,
        action: "task_version.validated",
        target: encodeId("tsv", work.id),
        detail: {
            passed: evaluation.checks.every((check) => check.ok),
            node: encodeId("nod", nodeId),
        },
    });
    return "accepted" as const;
}
