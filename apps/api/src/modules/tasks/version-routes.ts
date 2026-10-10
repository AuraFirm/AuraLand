import {
    finalizeRequestSchema,
    uploadPlanSchema,
    uploadStartRequestSchema,
    versionCreateRequestSchema,
    versionSchema,
    versionsResponseSchema,
    versionUpdateRequestSchema,
} from "@aura/contracts/api/task-versions";
import { decodeId, encodeId, idSchema, makeUuidV7 } from "@aura/contracts/ids";
import {
    UPLOAD_PART_BYTES_MIN,
    UPLOAD_PART_URL_LIFETIME_S,
    UPLOAD_PLAN_LIFETIME_S,
} from "@aura/contracts/limits";
import { appendAudit } from "@aura/db/audit";
import { CHECK_VIOLATION, postgresErrorCode } from "@aura/db/errors";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../app-env.ts";
import type { Clock } from "../../platform/clock.ts";
import { type ObjectStorage, uploadKey } from "../../platform/object-storage.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { Rng } from "../../platform/rng.ts";
import { taskAccess } from "./access.ts";
import { caller, invalid, notFound, readJson, refuse, unauthenticated } from "./route-support.ts";
import { getTask } from "./task-queries.ts";
import { verifyUpload } from "./upload-verify.ts";
import {
    finishUpload,
    getUpload,
    getVersion,
    insertUpload,
    insertVersion,
    listVersions,
    recordBundle,
    updateContent,
    type VersionRow,
} from "./version-queries.ts";

export interface VersionRouteDeps {
    readonly clock: Clock;
    readonly rng: Rng;
    readonly storage: ObjectStorage;
}

// Version and upload routes. Reading is decided by row-level security (a version the caller may not
// see does not exist for them); writing needs a writer role in the version's organization.
export function versionRoutes(deps: VersionRouteDeps): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.post("/tasks/:id/versions", handleCreate);
    routes.get("/tasks/:id/versions", handleList);
    routes.get("/task-versions/:id", handleGet);
    routes.patch("/task-versions/:id", handleUpdate);
    routes.post("/task-versions/:id/uploads", (c) => handleStartUpload(c, deps));
    routes.post("/task-versions/:id/finalize", (c) => handleFinalize(c, deps));
    return routes;
}

export function versionBody(row: VersionRow) {
    return versionSchema.parse({
        id: encodeId("tsv", row.id),
        task_id: encodeId("tsk", row.task_id),
        seq: row.seq,
        state: row.state,
        spec: row.spec,
        statement: row.statement,
        bundle:
            row.bundle_bytes === null || row.bundle_sha256 === null
                ? null
                : {
                      bytes: row.bundle_bytes,
                      sha256: Buffer.from(row.bundle_sha256).toString("hex"),
                  },
        waived: row.waived,
        created_by: encodeId("usr", row.created_by),
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
        released_at: row.released_at?.toISOString() ?? null,
    });
}

export function versionAudit(
    userId: string,
    row: { id: string; org_id: string },
    action: string,
    detail: Record<string, string | number | boolean> = {},
) {
    return {
        actorKind: "user",
        actorUserId: userId,
        orgId: row.org_id,
        action,
        target: encodeId("tsv", row.id),
        detail,
    } as const;
}

export function versionIdParam(c: Context<AppEnv>): string | null {
    const parsed = idSchema("tsv").safeParse(c.req.param("id"));
    return parsed.success ? decodeId("tsv", parsed.data) : null;
}

function taskIdParam(c: Context<AppEnv>): string | null {
    const parsed = idSchema("tsk").safeParse(c.req.param("id"));
    return parsed.success ? decodeId("tsk", parsed.data) : null;
}

async function handleCreate(c: Context<AppEnv>) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const taskId = taskIdParam(c);
    if (taskId === null || !versionCreateRequestSchema.safeParse(await readJson(c)).success) {
        return invalid(c);
    }
    const tx = c.get("tx");
    const task = await getTask(tx, taskId);
    if (task === null) return notFound(c);
    const denied = refuse(c, taskAccess(who.orgs, task.org_id, "write"));
    if (denied !== null) return denied;
    let versionId: string;
    try {
        versionId = await insertVersion(tx, { orgId: task.org_id, taskId, userId: who.userId });
    } catch (error) {
        if (postgresErrorCode(error) !== CHECK_VIOLATION) throw error;
        return problemResponse(c, "conflict", "This task has the maximum number of versions");
    }
    const row = await getVersion(tx, versionId);
    if (row === null) throw new Error("a new version is visible to its creator");
    await appendAudit(tx, versionAudit(who.userId, row, "task_version.created", { seq: row.seq }));
    return c.json(versionBody(row), 201);
}

async function handleList(c: Context<AppEnv>) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const taskId = taskIdParam(c);
    if (taskId === null) return invalid(c);
    const tx = c.get("tx");
    if ((await getTask(tx, taskId)) === null) return notFound(c);
    const rows = await listVersions(tx, taskId);
    return c.json(versionsResponseSchema.parse({ items: rows.map(versionBody) }));
}

async function handleGet(c: Context<AppEnv>) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const versionId = versionIdParam(c);
    if (versionId === null) return invalid(c);
    const row = await getVersion(c.get("tx"), versionId);
    return row === null ? notFound(c) : c.json(versionBody(row));
}

async function handleUpdate(c: Context<AppEnv>) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const versionId = versionIdParam(c);
    const body = versionUpdateRequestSchema.safeParse(await readJson(c));
    if (versionId === null || !body.success) return invalid(c);
    const tx = c.get("tx");
    const row = await getVersion(tx, versionId);
    if (row === null) return notFound(c);
    const denied = refuse(c, taskAccess(who.orgs, row.org_id, "write"));
    if (denied !== null) return denied;
    if (body.data.spec !== undefined && body.data.spec.kind !== row.task_kind) {
        return problemResponse(
            c,
            "invalid_request",
            "Invalid request",
            "spec kind differs from the task",
        );
    }
    if (!(await updateContent(tx, versionId, body.data))) {
        return problemResponse(c, "conflict", "This version can no longer be edited");
    }
    await appendAudit(tx, versionAudit(who.userId, row, "task_version.edited"));
    const updated = await getVersion(tx, versionId);
    if (updated === null) throw new Error("the version is visible to its writer");
    return c.json(versionBody(updated));
}

async function handleStartUpload(c: Context<AppEnv>, deps: VersionRouteDeps) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const versionId = versionIdParam(c);
    const body = uploadStartRequestSchema.safeParse(await readJson(c));
    if (versionId === null || !body.success) return invalid(c);
    const tx = c.get("tx");
    const row = await getVersion(tx, versionId);
    if (row === null) return notFound(c);
    const denied = refuse(c, taskAccess(who.orgs, row.org_id, "write"));
    if (denied !== null) return denied;
    if (row.state !== "draft") {
        return problemResponse(c, "conflict", "A bundle was already uploaded; make a new version");
    }
    const plan = await startUpload(tx, deps, who.userId, row, body.data);
    if (plan === null) {
        return problemResponse(c, "conflict", "Too many unfinished uploads; finish or wait");
    }
    await appendAudit(
        tx,
        versionAudit(who.userId, row, "task_version.upload_started", { bytes: body.data.bytes }),
    );
    return c.json(plan, 201);
}

type UploadStartBody = { bytes: number; sha256: string };

// Starts the multipart upload in storage, records it, and signs one URL per part. Returns null when
// the person has too many unfinished uploads (the database cap); the storage upload is then aborted
// so nothing is left behind.
async function startUpload(
    tx: Context<AppEnv>["var"]["tx"],
    deps: VersionRouteDeps,
    userId: string,
    row: VersionRow,
    declared: UploadStartBody,
) {
    const nowMs = deps.clock.nowUnixMs();
    const uploadUuid = makeUuidV7(nowMs, deps.rng.nextBytes(10));
    const partBytes = UPLOAD_PART_BYTES_MIN;
    const partCount = Math.ceil(declared.bytes / partBytes);
    const key = uploadKey(row.org_id, uploadUuid);
    const storageUploadId = await deps.storage.beginMultipart(key);
    const expiresAt = new Date(nowMs + UPLOAD_PLAN_LIFETIME_S * 1000);
    try {
        await insertUpload(tx, {
            id: uploadUuid,
            orgId: row.org_id,
            versionId: row.id,
            userId,
            storageUploadId,
            bytes: declared.bytes,
            sha256Hex: declared.sha256,
            partBytes,
            partCount,
            createdAt: new Date(nowMs),
            expiresAt,
        });
    } catch (error) {
        await deps.storage.abortMultipart(key, storageUploadId);
        if (postgresErrorCode(error) === CHECK_VIOLATION) return null;
        throw error;
    }
    const parts = [];
    for (let index = 1; index <= partCount; index++) {
        const bytes = index < partCount ? partBytes : declared.bytes - partBytes * (partCount - 1);
        const url = await deps.storage.partUrl({
            key,
            uploadId: storageUploadId,
            partNumber: index,
            bytes,
            lifetimeS: UPLOAD_PART_URL_LIFETIME_S,
        });
        parts.push({ part_number: index, bytes, url });
    }
    return uploadPlanSchema.parse({
        upload_id: encodeId("bup", uploadUuid),
        expires_at: expiresAt.toISOString(),
        parts,
    });
}

async function handleFinalize(c: Context<AppEnv>, deps: VersionRouteDeps) {
    const who = caller(c);
    if (who === null) return unauthenticated(c);
    const versionId = versionIdParam(c);
    const body = finalizeRequestSchema.safeParse(await readJson(c));
    if (versionId === null || !body.success) return invalid(c);
    const tx = c.get("tx");
    const row = await getVersion(tx, versionId);
    if (row === null) return notFound(c);
    const denied = refuse(c, taskAccess(who.orgs, row.org_id, "write"));
    if (denied !== null) return denied;
    const upload = await getUpload(tx, decodeId("bup", body.data.upload_id), versionId);
    const nowMs = deps.clock.nowUnixMs();
    if (upload === null || upload.finished_at !== null || upload.expires_at.getTime() <= nowMs) {
        return problemResponse(c, "conflict", "That upload is finished or has expired");
    }
    if (row.state !== "draft")
        return problemResponse(c, "conflict", "This version already has a bundle");
    const sha256Hex = Buffer.from(upload.expected_sha256).toString("hex");
    const verdict = await verifyUpload(deps.storage, {
        orgUuid: row.org_id,
        stagingKey: uploadKey(row.org_id, upload.id),
        uploadId: upload.storage_upload_id,
        partCount: upload.part_count,
        bytes: upload.expected_bytes,
        sha256Hex,
    });
    if (!verdict.ok) return refusedUpload(c, tx, upload.id, verdict.reason, nowMs);
    if (!(await recordBundle(tx, versionId, { bytes: upload.expected_bytes, sha256Hex }))) {
        return problemResponse(c, "conflict", "This version already has a bundle");
    }
    await finishUpload(tx, upload.id, new Date(nowMs));
    await appendAudit(
        tx,
        versionAudit(who.userId, row, "task_version.bundle_verified", {
            bytes: upload.expected_bytes,
            sha256: sha256Hex,
        }),
    );
    const updated = await getVersion(tx, versionId);
    if (updated === null) throw new Error("the version is visible to its writer");
    return c.json(versionBody(updated));
}

// A bundle that does not match what was declared ends that upload (the staged object is already
// gone); missing parts leave it open so the rest can still be sent.
async function refusedUpload(
    c: Context<AppEnv>,
    tx: Context<AppEnv>["var"]["tx"],
    uploadId: string,
    reason: "parts_missing" | "size_mismatch" | "hash_mismatch",
    nowMs: number,
) {
    if (reason === "parts_missing") {
        return problemResponse(c, "conflict", "Some parts have not been uploaded", reason);
    }
    await finishUpload(tx, uploadId, new Date(nowMs));
    return problemResponse(c, "invalid_request", "The uploaded bundle does not match", reason);
}
