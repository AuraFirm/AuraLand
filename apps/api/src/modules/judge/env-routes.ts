import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import {
    envCompleteRequestSchema,
    envLeaseResponseSchema,
    jobAcceptedSchema,
} from "@aura/contracts/judge-protocol";
import { LEASE_POLL_MS } from "@aura/contracts/limits";
import { appendAudit } from "@aura/db/audit";
import { withRequestContext } from "@aura/db/context";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import { finishRun, readTrace, readWork, verifyTraceSignature } from "../environments/service.ts";
import {
    completeJob,
    failJob,
    getJob,
    jobDepsFor,
    LEASE_TTL_MS,
    leaseJob,
} from "../jobs/service.ts";
import { findNode } from "./node-queries.ts";
import type { JudgeRouteDeps } from "./routes.ts";

// The node side of environment runs (Stage 8, slice 8): leasing an env.run job and reporting its trace. Same lease, epoch and
// dead-letter rules as every other job; what is new is that the report is a signed trace, checked before it is believed.

type Tx = Parameters<Parameters<typeof withRequestContext>[2]>[0];
export const ENV_KIND = "env.run";
const payloadSchema = z.object({ env_run_id: z.string() });
const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;
const DOWNLOAD_TTL_S = 900;
const inTransaction = <T>(
    deps: JudgeRouteDeps,
    work: Parameters<typeof withRequestContext<T>>[2],
) => withRequestContext(deps.sql, WORKER, work);

class LeaseLostError extends Error {}

async function leaseOne(tx: Tx, deps: JudgeRouteDeps, nodeId: string) {
    const node = await tx`select tiers from judge_nodes where id = ${nodeId}`;
    if (
        !z
            .object({ tiers: z.array(z.number()) })
            .parse(node[0])
            .tiers.includes(2)
    )
        return null; // not a Tier-2 node
    const queue = jobDepsFor(tx, deps.clock, deps.rng);
    const job = await leaseJob(queue, "env", nodeId);
    if (job === null) return null;
    const payload = payloadSchema.safeParse(job.payload);
    const work = payload.success ? await readWork(tx, payload.data.env_run_id) : null;
    if (work === null || work.run_state !== "queued") {
        await completeJob(queue, job.id, job.leaseEpoch, { skipped: true });
        return "skipped" as const;
    }
    return {
        job_id: encodeId("job", job.id),
        lease_epoch: job.leaseEpoch,
        lease_ttl_s: LEASE_TTL_MS / 1000,
        run_id: encodeId("evr", payload.success ? payload.data.env_run_id : ""),
        environment: {
            id: encodeId("env", work.env_id),
            spec: work.spec,
            image_key: work.image_key,
            image_download_url: await deps.storage.downloadUrl(work.image_key, DOWNLOAD_TTL_S),
            hidden_key: work.hidden_key,
            hidden_download_url: await deps.storage.downloadUrl(work.hidden_key, DOWNLOAD_TTL_S),
            hidden_sha256: Buffer.from(work.hidden_sha256).toString("hex"),
        },
    };
}

export async function handleEnvLease(c: Context<AppEnv>, deps: JudgeRouteDeps, waitMs: number) {
    const nodeId = c.get("nodeId");
    const looks = Math.floor(waitMs / LEASE_POLL_MS) + 1;
    for (let look = 0; look < looks; look++) {
        const job = await inTransaction(deps, (tx) => leaseOne(tx, deps, nodeId));
        if (job === "skipped") {
            look--;
            continue;
        }
        if (job !== null) return c.json(envLeaseResponseSchema.parse({ job }));
        if (look < looks - 1) await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
    }
    return c.json(envLeaseResponseSchema.parse({ job: null }));
}

export async function handleEnvComplete(c: Context<AppEnv>, deps: JudgeRouteDeps) {
    const jobParsed = idSchema("job").safeParse(c.req.param("id"));
    const body = envCompleteRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!jobParsed.success || !body.success)
        return problemResponse(c, "invalid_request", "Invalid request");
    const outcome = await inTransaction(deps, (tx) =>
        settle(tx, deps, c.get("nodeId"), decodeId("job", jobParsed.data), body.data),
    ).catch((error: unknown) => {
        if (error instanceof LeaseLostError) return "stale" as const;
        throw error;
    });
    if (outcome === "stale") return problemResponse(c, "conflict", "The lease is no longer yours");
    if (outcome === "rejected")
        return problemResponse(c, "invalid_request", "The result was not accepted");
    return c.json(jobAcceptedSchema.parse({ accepted: true }));
}

async function settle(
    tx: Tx,
    deps: JudgeRouteDeps,
    nodeId: string,
    jobId: string,
    body: z.infer<typeof envCompleteRequestSchema>,
) {
    const queue = jobDepsFor(tx, deps.clock, deps.rng);
    const job = await getJob(queue, jobId);
    const mine =
        job !== null &&
        job.kind === ENV_KIND &&
        job.state === "leased" &&
        job.leaseOwner === nodeId &&
        job.leaseEpoch === body.lease_epoch;
    if (!mine) return "stale" as const;
    const runId = payloadSchema.parse(job.payload).env_run_id;
    const node = await findNode(tx, nodeId);
    const read =
        node !== null && verifyTraceSignature(node.public_key, body.trace, body.trace_signature)
            ? readTrace(body.trace)
            : null;
    if (read === null || !read.ok) {
        // A report that is not signed by this node, or cannot be true, goes to another node (and, after the last attempt, dies).
        await failJob(queue, {
            id: jobId,
            epoch: body.lease_epoch,
            error: read === null ? "bad signature" : read.reason,
            retryable: true,
        });
        return "rejected" as const;
    }
    if (!(await completeJob(queue, jobId, body.lease_epoch, { run: runId })))
        throw new LeaseLostError();
    await finishRun(tx, {
        run: runId,
        node: nodeId,
        isolation: read.trace.isolation,
        outcome: read.trace.outcome,
        score: read.score,
        trace: read.trace,
        signature: body.trace_signature,
        nowMs: deps.clock.nowUnixMs(),
    });
    await appendAudit(tx, {
        actorKind: "worker",
        actorUserId: null,
        orgId: null,
        action: "environment.run_finished",
        target: encodeId("evr", runId),
        detail: {
            outcome: read.trace.outcome,
            isolation: read.trace.isolation,
            flags: read.trace.flags.length,
        },
    });
    return "accepted" as const;
}
