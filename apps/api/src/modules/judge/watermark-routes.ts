import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import { jobAcceptedSchema } from "@aura/contracts/judge-protocol";
import { BUNDLE_BYTES_MAX, LEASE_POLL_MS } from "@aura/contracts/limits";
import {
    watermarkCompleteRequestSchema,
    watermarkLeaseResponseSchema,
    watermarkUploadRequestSchema,
    watermarkUploadResponseSchema,
} from "@aura/contracts/watermark";
import { appendAudit } from "@aura/db/audit";
import { withRequestContext } from "@aura/db/context";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import { deliveryBundleKey, uploadKey } from "../../platform/object-storage.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import {
    completeJob,
    failJob,
    getJob,
    type JobDeps,
    jobDepsFor,
    LEASE_TTL_MS,
    leaseJob,
} from "../jobs/service.ts";
import { judgeReport, recordDeliveryBundle, watermarkJobInput } from "../watermark/service.ts";
import type { JudgeRouteDeps } from "./routes.ts";

// The node side of delivery watermarks (Stage 4C): leasing a watermark job, getting a URL for the
// rewritten bundle, and reporting what was done. The node rewrites in a box and re-runs the harness; the
// control plane decides whether that is good enough (watermark/rules.ts) and the database records the
// delivered bundle (record_delivery_bundle, migration 0031).

type Tx = Parameters<Parameters<typeof withRequestContext>[2]>[0];
export const WATERMARK_KIND = "delivery.watermark";
export const watermarkPayloadSchema = z.object({
    delivery_id: z.string(),
    task_version_id: z.string(),
});
const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;
const UPLOAD_URL_LIFETIME_S = 10 * 60;
const inTransaction = <T>(
    deps: JudgeRouteDeps,
    work: Parameters<typeof withRequestContext<T>>[2],
) => withRequestContext(deps.sql, WORKER, work);
const invalid = (c: Context<AppEnv>) => problemResponse(c, "invalid_request", "Invalid request");
const stale = (c: Context<AppEnv>) =>
    problemResponse(c, "conflict", "The lease is no longer yours");

// Leases the next watermark job. A job whose delivery is no longer pending is closed without a node.
async function leaseOne(tx: Tx, deps: JudgeRouteDeps, nodeId: string) {
    const queue = jobDepsFor(tx, deps.clock, deps.rng);
    const job = await leaseJob(queue, "watermark", nodeId);
    if (job === null) return null;
    const payload = watermarkPayloadSchema.safeParse(job.payload);
    const input = payload.success
        ? await watermarkJobInput(tx, payload.data.delivery_id, payload.data.task_version_id)
        : null;
    if (input === null) {
        await completeJob(queue, job.id, job.leaseEpoch, { skipped: true });
        return "skipped" as const;
    }
    return {
        job_id: encodeId("job", job.id),
        lease_epoch: job.leaseEpoch,
        lease_ttl_s: LEASE_TTL_MS / 1000,
        kind: WATERMARK_KIND,
        task: {
            bundle: { sha256: input.bundle_sha256, bytes: input.bundle_bytes },
            spec: input.spec,
            tag: input.tag,
        },
    };
}

export async function handleWatermarkLease(
    c: Context<AppEnv>,
    deps: JudgeRouteDeps,
    waitMs: number,
) {
    const nodeId = c.get("nodeId");
    const looks = Math.floor(waitMs / LEASE_POLL_MS) + 1;
    for (let look = 0; look < looks; look++) {
        const job = await inTransaction(deps, (tx) => leaseOne(tx, deps, nodeId));
        if (job === "skipped") {
            look--;
            continue;
        }
        if (job !== null) return c.json(watermarkLeaseResponseSchema.parse({ job }));
        if (look < looks - 1) await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
    }
    return c.json(watermarkLeaseResponseSchema.parse({ job: null }));
}

interface Held {
    readonly queue: JobDeps;
    readonly deliveryId: string;
    readonly versionId: string;
    readonly jobId: string;
    readonly epoch: number;
}

// The job exists, is a watermark job, is leased to this node with this epoch; otherwise "not yours".
async function held(
    tx: Tx,
    deps: JudgeRouteDeps,
    jobId: string,
    nodeId: string,
    epoch: number,
): Promise<Held | null> {
    const queue = jobDepsFor(tx, deps.clock, deps.rng);
    const job = await getJob(queue, jobId);
    if (
        job === null ||
        job.kind !== WATERMARK_KIND ||
        job.state !== "leased" ||
        job.leaseOwner !== nodeId ||
        job.leaseEpoch !== epoch
    ) {
        return null;
    }
    const payload = watermarkPayloadSchema.safeParse(job.payload);
    if (!payload.success) return null;
    return {
        queue,
        deliveryId: payload.data.delivery_id,
        versionId: payload.data.task_version_id,
        jobId,
        epoch,
    };
}

function jobIdOf(c: Context<AppEnv>): string | null {
    const parsed = idSchema("job").safeParse(c.req.param("id"));
    return parsed.success ? decodeId("job", parsed.data) : null;
}

// The staging place of a job's rewritten bundle: one object per job, under the customer's uploads.
const stagingKey = (customerOrgId: string, jobId: string) => uploadKey(customerOrgId, jobId);

export async function handleWatermarkUpload(c: Context<AppEnv>, deps: JudgeRouteDeps) {
    const jobId = jobIdOf(c);
    const body = watermarkUploadRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (jobId === null || !body.success) return invalid(c);
    const nodeId = c.get("nodeId");
    const target = await inTransaction(deps, async (tx) => {
        const mine = await held(tx, deps, jobId, nodeId, body.data.lease_epoch);
        if (mine === null) return null;
        const input = await watermarkJobInput(tx, mine.deliveryId, mine.versionId);
        return input === null ? null : { customerOrgId: await customerOrgOf(tx, mine.deliveryId) };
    });
    if (target === null || target.customerOrgId === null) return stale(c);
    const key = stagingKey(target.customerOrgId, jobId);
    const uploadId = await deps.storage.beginMultipart(key);
    const url = await deps.storage.partUrl({
        key,
        uploadId,
        partNumber: 1,
        bytes: body.data.bytes,
        lifetimeS: UPLOAD_URL_LIFETIME_S,
    });
    c.header("Cache-Control", "no-store");
    return c.json(watermarkUploadResponseSchema.parse({ upload_id: uploadId, url }));
}

// The customer organization of a delivery, read through the worker's one allowed function path.
async function customerOrgOf(tx: Tx, deliveryId: string): Promise<string | null> {
    const rows = await tx`select watermark_customer_org(${deliveryId}) as org`;
    return z.object({ org: z.string().nullable() }).parse(rows[0]).org;
}

type CompleteBody = z.infer<typeof watermarkCompleteRequestSchema>;

export async function handleWatermarkComplete(c: Context<AppEnv>, deps: JudgeRouteDeps) {
    const jobId = jobIdOf(c);
    const body = watermarkCompleteRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (jobId === null || !body.success) return invalid(c);
    const nodeId = c.get("nodeId");
    const before = await inTransaction(deps, async (tx) => {
        const mine = await held(tx, deps, jobId, nodeId, body.data.lease_epoch);
        if (mine === null) return null;
        const input = await watermarkJobInput(tx, mine.deliveryId, mine.versionId);
        const customerOrgId = input === null ? null : await customerOrgOf(tx, mine.deliveryId);
        return input === null || customerOrgId === null ? null : { mine, input, customerOrgId };
    });
    if (before === null) return stale(c);
    const judgement = judgeReport(before.input.spec, body.data.result);
    if (!judgement.ok) {
        await inTransaction(deps, (tx) =>
            failJob(jobDepsFor(tx, deps.clock, deps.rng), {
                id: jobId,
                epoch: body.data.lease_epoch,
                error: judgement.reason,
                retryable: true,
            }),
        );
        return problemResponse(c, "invalid_request", "The result was not accepted");
    }
    const stored = await storeDelivered(deps, before, body.data, jobId);
    if (stored === "refused") {
        await inTransaction(deps, (tx) =>
            failJob(jobDepsFor(tx, deps.clock, deps.rng), {
                id: jobId,
                epoch: body.data.lease_epoch,
                error: "the rewritten bundle was not uploaded as announced",
                retryable: true,
            }),
        );
        return problemResponse(c, "invalid_request", "The result was not accepted");
    }
    const outcome = await inTransaction(deps, (tx) =>
        settle(tx, deps, { nodeId, jobId, body: body.data, stored }),
    );
    return outcome === "stale" ? stale(c) : c.json(jobAcceptedSchema.parse({ accepted: true }));
}

interface Stored {
    readonly sha256: string;
    readonly bytes: number;
}

// For a rewritten bundle: assemble the upload, measure what arrived (the node's word about its hash and
// size is never taken), and move it to the delivery's own key. For an unchanged one: nothing to store.
async function storeDelivered(
    deps: JudgeRouteDeps,
    before: {
        input: { bundle_sha256: string; bundle_bytes: number };
        customerOrgId: string;
        mine: Held;
    },
    body: CompleteBody,
    jobId: string,
): Promise<Stored | "refused"> {
    const { result } = body;
    if (result.outcome === "unchanged") {
        return { sha256: before.input.bundle_sha256, bytes: before.input.bundle_bytes };
    }
    const staging = stagingKey(before.customerOrgId, jobId);
    const completed = await deps.storage.completeMultipart(staging, result.upload_id, 1);
    if (completed.kind !== "completed") return "refused";
    const measured = await deps.storage.measure(staging, BUNDLE_BYTES_MAX);
    if (measured.kind !== "measured") {
        await deps.storage.remove(staging);
        return "refused";
    }
    const finalKey = deliveryBundleKey(
        before.customerOrgId,
        before.mine.deliveryId,
        measured.sha256,
    );
    await deps.storage.copy(staging, finalKey);
    await deps.storage.remove(staging);
    return { sha256: measured.sha256, bytes: measured.bytes };
}

async function settle(
    tx: Tx,
    deps: JudgeRouteDeps,
    input: { nodeId: string; jobId: string; body: CompleteBody; stored: Stored },
) {
    const mine = await held(tx, deps, input.jobId, input.nodeId, input.body.lease_epoch);
    if (mine === null) return "stale" as const;
    const job = await watermarkJobInput(tx, mine.deliveryId, mine.versionId);
    if (job === null) return "stale" as const;
    const result = input.body.result;
    const rewritten = result.outcome === "rewritten";
    const recorded = await recordDeliveryBundle(tx, {
        deliveryId: mine.deliveryId,
        versionId: mine.versionId,
        sourceSha256Hex: job.bundle_sha256,
        sha256Hex: input.stored.sha256,
        bytes: input.stored.bytes,
        answers: rewritten && result.answers,
        solutions: rewritten && result.solutions,
        checked: !rewritten || result.observations !== null,
        nodeId: input.nodeId,
        nowMs: deps.clock.nowUnixMs(),
    });
    if (!(await completeJob(mine.queue, mine.jobId, mine.epoch, { outcome: result.outcome }))) {
        throw new Error("the lease was lost while recording");
    }
    await appendAudit(tx, {
        actorKind: "worker",
        actorUserId: null,
        orgId: null,
        action: "delivery.bundle_recorded",
        target: encodeId("dlv", mine.deliveryId),
        detail: {
            version: encodeId("tsv", mine.versionId),
            outcome: result.outcome,
            recorded,
            node: encodeId("nod", input.nodeId),
        },
    });
    return "accepted" as const;
}
