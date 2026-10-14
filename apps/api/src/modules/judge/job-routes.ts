import { decodeId, encodeId, idSchema } from "@aura/contracts/ids";
import {
    jobAcceptedSchema,
    jobCompleteRequestSchema,
    jobFailRequestSchema,
    jobHeartbeatRequestSchema,
    jobHeartbeatResponseSchema,
    leaseRequestSchema,
    leaseResponseSchema,
} from "@aura/contracts/judge-protocol";
import type { Verdict } from "@aura/contracts/judging";
import { LEASE_POLL_MS, NODE_BUNDLE_URL_LIFETIME_S } from "@aura/contracts/limits";
import { appendAudit } from "@aura/db/audit";
import { withRequestContext } from "@aura/db/context";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import { bundleKey } from "../../platform/object-storage.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import {
    completeJob,
    failJob,
    getJob,
    heartbeatJob,
    jobDepsFor,
    LEASE_TTL_MS,
    leaseJob,
} from "../jobs/service.ts";
import { summarize } from "../submissions/service.ts";
import { readValidationWork } from "../validation/service.ts";
import { watermarkJobInput } from "../watermark/service.ts";
import {
    backToQueue,
    lockSubmissionWork,
    markFailedSystem,
    recordVerdict,
    startJudging,
} from "./job-queries.ts";
import { nodeAuth } from "./node-auth.ts";
import { findNode } from "./node-queries.ts";
import type { JudgeRouteDeps } from "./routes.ts";
import {
    handleValidationComplete,
    handleValidationLease,
    VALIDATE_KIND,
    payloadSchema as validatePayloadSchema,
} from "./validate-routes.ts";
import {
    handleWatermarkComplete,
    handleWatermarkLease,
    handleWatermarkUpload,
    WATERMARK_KIND,
    watermarkPayloadSchema,
} from "./watermark-routes.ts";

const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;
const payloadSchema = z.object({ submission_id: z.string() });

export function jobRoutes(deps: JudgeRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.use("/lease", nodeAuth(deps));
    routes.use("/jobs/*", nodeAuth(deps));
    routes.use("/bundles/*", nodeAuth(deps));
    routes.post("/lease", (c) => handleLease(c, deps));
    routes.post("/jobs/:id/heartbeat", (c) => handleHeartbeat(c, deps));
    routes.post("/jobs/:id/complete", (c) => handleComplete(c, deps));
    routes.post("/jobs/:id/validation", (c) => handleValidationComplete(c, deps));
    routes.post("/jobs/:id/watermark/upload", (c) => handleWatermarkUpload(c, deps));
    routes.post("/jobs/:id/watermark", (c) => handleWatermarkComplete(c, deps));
    routes.post("/jobs/:id/fail", (c) => handleFail(c, deps));
    routes.get("/bundles/:sha256", (c) => handleBundle(c, deps));
    return routes;
}

const invalid = (c: Context<AppEnv>) => problemResponse(c, "invalid_request", "Invalid request");
const stale = (c: Context<AppEnv>) =>
    problemResponse(c, "conflict", "The lease is no longer yours");
const inTransaction = <T>(
    deps: JudgeRouteDeps,
    work: Parameters<typeof withRequestContext<T>>[2],
) => withRequestContext(deps.sql, WORKER, work);

function jobIdParam(c: Context<AppEnv>): string | null {
    const parsed = idSchema("job").safeParse(c.req.param("id"));
    return parsed.success ? decodeId("job", parsed.data) : null;
}

// ---- lease -----------------------------------------------------------------------------------

async function handleLease(c: Context<AppEnv>, deps: JudgeRouteDeps) {
    const body = leaseRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    const nodeId = c.get("nodeId");
    const node = await inTransaction(deps, (tx) => findNode(tx, nodeId));
    if (node === null || node.state !== "active") {
        return problemResponse(c, "conflict", "This node is not active");
    }
    if (body.data.queue === "validate") return handleValidationLease(c, deps, body.data.wait_ms);
    if (body.data.queue === "watermark") return handleWatermarkLease(c, deps, body.data.wait_ms);
    // Waiting is a series of short looks, never an open transaction.
    const looks = Math.floor(body.data.wait_ms / LEASE_POLL_MS) + 1;
    for (let look = 0; look < looks; look++) {
        const job = await inTransaction(deps, (tx) => leaseOne(tx, deps, nodeId));
        if (job === "skipped") {
            look--; // a job that needed no judging was settled; ask again at once
            continue;
        }
        if (job !== null) return c.json(leaseResponseSchema.parse({ job }));
        if (look < looks - 1) await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
    }
    return c.json(leaseResponseSchema.parse({ job: null }));
}

// Leases the next judge job and marks its submission as being judged, in one transaction. A job whose
// submission is gone or no longer waiting is settled without bothering a node.
async function leaseOne(
    tx: Parameters<Parameters<typeof withRequestContext>[2]>[0],
    deps: JudgeRouteDeps,
    nodeId: string,
) {
    const queue = jobDepsFor(tx, deps.clock, deps.rng);
    const job = await leaseJob(queue, "judge", nodeId);
    if (job === null) return null;
    const nowMs = deps.clock.nowUnixMs();
    const payload = payloadSchema.safeParse(job.payload);
    const work = payload.success ? await lockSubmissionWork(tx, payload.data.submission_id) : null;
    // "judging" is legitimate here: a node that held this job went silent, its lease expired and the
    // job came back. Only a finished or cancelled submission needs no judging.
    if (work === null || (work.state !== "queued" && work.state !== "judging")) {
        await completeJob(queue, job.id, job.leaseEpoch, { skipped: true });
        return "skipped" as const;
    }
    if (work.spec === null || work.bundle_sha256 === null || work.bundle_bytes === null) {
        await failJob(queue, {
            id: job.id,
            epoch: job.leaseEpoch,
            error: "task version has no bundle or spec",
            retryable: false,
        });
        await markFailedSystem(tx, work.id, nowMs);
        return "skipped" as const;
    }
    await startJudging(tx, work.id, nowMs);
    return {
        job_id: encodeId("job", job.id),
        lease_epoch: job.leaseEpoch,
        lease_ttl_s: LEASE_TTL_MS / 1000,
        kind: "judge.tier1" as const,
        submission: { id: encodeId("sub", work.id), language: work.language, source: work.source },
        task: {
            version_id: encodeId("tsv", work.task_version_id),
            bundle: {
                sha256: Buffer.from(work.bundle_sha256).toString("hex"),
                bytes: work.bundle_bytes,
            },
            spec: work.spec,
        },
    };
}

// ---- heartbeat, complete, fail ---------------------------------------------------------------

// The job exists, is leased to this node, and carries this epoch; anything else is "not yours".
async function ownedJob(
    tx: Parameters<Parameters<typeof withRequestContext>[2]>[0],
    deps: JudgeRouteDeps,
    jobId: string,
    nodeId: string,
    epoch: number,
) {
    const queue = jobDepsFor(tx, deps.clock, deps.rng);
    const job = await getJob(queue, jobId);
    const mine =
        job !== null &&
        job.state === "leased" &&
        job.leaseOwner === nodeId &&
        job.leaseEpoch === epoch;
    return mine ? { queue, job } : null;
}

async function handleHeartbeat(c: Context<AppEnv>, deps: JudgeRouteDeps) {
    const jobId = jobIdParam(c);
    const body = jobHeartbeatRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (jobId === null || !body.success) return invalid(c);
    const ok = await inTransaction(deps, async (tx) => {
        const owned = await ownedJob(tx, deps, jobId, c.get("nodeId"), body.data.lease_epoch);
        return owned !== null && (await heartbeatJob(owned.queue, jobId, body.data.lease_epoch));
    });
    return ok
        ? c.json(jobHeartbeatResponseSchema.parse({ lease_ttl_s: LEASE_TTL_MS / 1000 }))
        : stale(c);
}

class LeaseLostError extends Error {}

type Tx = Parameters<Parameters<typeof withRequestContext>[2]>[0];
type CompleteBody = ReturnType<typeof jobCompleteRequestSchema.parse>;
type Owned = NonNullable<Awaited<ReturnType<typeof ownedJob>>>;
type Work = NonNullable<Awaited<ReturnType<typeof lockSubmissionWork>>>;

// A report that cannot be true, or that says the node itself failed, sends the job to another node.
// The participant sees nothing of it: their submission simply waits again.
async function rejectReport(
    tx: Tx,
    deps: JudgeRouteDeps,
    owned: Owned,
    work: Work,
    body: CompleteBody,
    why: string,
) {
    await failJob(owned.queue, {
        id: owned.job.id,
        epoch: body.lease_epoch,
        error: why,
        retryable: true,
    });
    await backToQueue(tx, work.id, deps.clock.nowUnixMs());
    return "rejected" as const;
}

async function acceptReport(
    tx: Tx,
    deps: JudgeRouteDeps,
    input: {
        owned: Owned;
        work: Work;
        body: CompleteBody;
        nodeId: string;
        verdict: Verdict;
        score: number;
    },
) {
    const { owned, work, body, nodeId } = input;
    const nowMs = deps.clock.nowUnixMs();
    // Both steps must happen or neither: if either finds the lease or the submission changed under us,
    // the whole transaction is thrown away.
    const completed = await completeJob(owned.queue, owned.job.id, body.lease_epoch, {
        verdict: input.verdict,
        score: input.score,
    });
    if (!completed) throw new LeaseLostError();
    const recorded = await recordVerdict(tx, {
        submissionId: work.id,
        orgId: work.org_id,
        verdict: input.verdict,
        score: input.score,
        nowMs,
        tests: body.result.tests.map((t) => ({
            testId: t.test_id,
            verdict: t.verdict,
            cpuMs: t.cpu_ms,
            wallMs: t.wall_ms,
            memoryKib: t.memory_kib,
            message: t.checker_msg === undefined ? null : stripControl(t.checker_msg),
        })),
    });
    if (!recorded) throw new LeaseLostError();
    await appendAudit(tx, {
        actorKind: "worker",
        actorUserId: null,
        orgId: work.org_id,
        action: "submission.judged",
        target: encodeId("sub", work.id),
        detail: { verdict: input.verdict, score: input.score, node: encodeId("nod", nodeId) },
    });
    return "accepted" as const;
}

async function settleReport(
    tx: Tx,
    deps: JudgeRouteDeps,
    nodeId: string,
    jobId: string,
    body: CompleteBody,
) {
    const owned = await ownedJob(tx, deps, jobId, nodeId, body.lease_epoch);
    if (owned === null || owned.job.kind !== "judge.tier1") return "stale" as const;
    const work = await lockSubmissionWork(tx, payloadSchema.parse(owned.job.payload).submission_id);
    if (work === null || work.spec === null) return "stale" as const;
    const results = body.result.tests.map((t) => ({ testId: t.test_id, verdict: t.verdict }));
    const summary = summarize(work.spec, body.result.compile_ok, results);
    if (!summary.ok)
        return rejectReport(tx, deps, owned, work, body, `invalid result: ${summary.reason}`);
    if (summary.verdict === "SE")
        return rejectReport(tx, deps, owned, work, body, "node reported a system error");
    return acceptReport(tx, deps, {
        owned,
        work,
        body,
        nodeId,
        verdict: summary.verdict,
        score: summary.score,
    });
}

async function handleComplete(c: Context<AppEnv>, deps: JudgeRouteDeps) {
    const jobId = jobIdParam(c);
    const body = jobCompleteRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (jobId === null || !body.success) return invalid(c);
    const nodeId = c.get("nodeId");
    const outcome = await inTransaction(deps, (tx) =>
        settleReport(tx, deps, nodeId, jobId, body.data),
    ).catch((error: unknown) => {
        if (error instanceof LeaseLostError) return "stale" as const;
        throw error;
    });
    if (outcome === "stale") return stale(c);
    if (outcome === "rejected")
        return problemResponse(c, "invalid_request", "The result was not accepted");
    return c.json(jobAcceptedSchema.parse({ accepted: true }));
}

function stripControl(text: string): string {
    let cleaned = "";
    for (const character of text) {
        const code = character.charCodeAt(0);
        cleaned += code < 0x20 || code === 0x7f ? " " : character;
    }
    return cleaned;
}

async function handleFail(c: Context<AppEnv>, deps: JudgeRouteDeps) {
    const jobId = jobIdParam(c);
    const body = jobFailRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (jobId === null || !body.success) return invalid(c);
    const outcome = await inTransaction(deps, async (tx) => {
        const owned = await ownedJob(tx, deps, jobId, c.get("nodeId"), body.data.lease_epoch);
        if (owned === null) return "stale" as const;
        const result = await failJob(owned.queue, {
            id: jobId,
            epoch: body.data.lease_epoch,
            error: body.data.error,
            retryable: body.data.retryable,
        });
        // A validation job needs nothing else: if it dies, housekeeping returns its version.
        // Validation and watermark jobs need nothing else: a dead one is visible in the queue.
        if (owned.job.kind !== "judge.tier1") return result;
        const payload = payloadSchema.parse(owned.job.payload);
        const nowMs = deps.clock.nowUnixMs();
        if (result === "retried") await backToQueue(tx, payload.submission_id, nowMs);
        else if (result === "dead") await markFailedSystem(tx, payload.submission_id, nowMs);
        return result;
    });
    return outcome === "stale" ? stale(c) : c.json(jobAcceptedSchema.parse({ accepted: true }));
}

// ---- bundle download -------------------------------------------------------------------------

// The bundle a leased job is about, whichever kind of job it is: a submission's task version or the
// version under validation. Null when the job's subject is gone or has no bundle.
async function bundleOf(tx: Tx, job: { kind: string; payload: unknown }) {
    if (job.kind === VALIDATE_KIND) {
        const payload = validatePayloadSchema.safeParse(job.payload);
        const work = payload.success
            ? await readValidationWork(tx, payload.data.task_version_id)
            : null;
        if (work === null || work.bundle_sha256 === null) return null;
        return { orgId: work.org_id, sha256: Buffer.from(work.bundle_sha256).toString("hex") };
    }
    if (job.kind === WATERMARK_KIND) {
        const payload = watermarkPayloadSchema.safeParse(job.payload);
        const input = payload.success
            ? await watermarkJobInput(tx, payload.data.delivery_id, payload.data.task_version_id)
            : null;
        return input === null ? null : { orgId: input.task_org_id, sha256: input.bundle_sha256 };
    }
    const payload = payloadSchema.safeParse(job.payload);
    const work = payload.success ? await lockSubmissionWork(tx, payload.data.submission_id) : null;
    if (work === null || work.bundle_sha256 === null) return null;
    return { orgId: work.org_id, sha256: Buffer.from(work.bundle_sha256).toString("hex") };
}

// A node may download only the bundle of a task it holds a live lease for, through a short-lived URL.
async function handleBundle(c: Context<AppEnv>, deps: JudgeRouteDeps) {
    const sha = z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .safeParse(c.req.param("sha256"));
    const jobParsed = idSchema("job").safeParse(c.req.query("job_id"));
    if (!sha.success || !jobParsed.success) return invalid(c);
    const nodeId = c.get("nodeId");
    const orgId = await inTransaction(deps, async (tx) => {
        const queue = jobDepsFor(tx, deps.clock, deps.rng);
        const job = await getJob(queue, decodeId("job", jobParsed.data));
        if (job === null || job.state !== "leased" || job.leaseOwner !== nodeId) return null;
        const work = await bundleOf(tx, job);
        const holds = work !== null && work.sha256 === sha.data;
        if (!holds) return null;
        // Every grant of a bundle read is on record: who (which node), what (hash) and for which job.
        await appendAudit(tx, {
            actorKind: "worker",
            actorUserId: null,
            orgId: work.orgId,
            action: "bundle.node_download",
            target: `sha256:${sha.data}`,
            detail: { node: encodeId("nod", nodeId), job: jobParsed.data },
        });
        return work.orgId;
    });
    if (orgId === null) return problemResponse(c, "not_found", "Not found");
    const url = await deps.storage.downloadUrl(
        bundleKey(orgId, sha.data),
        NODE_BUNDLE_URL_LIFETIME_S,
    );
    c.header("Cache-Control", "no-store");
    return c.redirect(url, 302);
}
