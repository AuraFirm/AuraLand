import { VERSIONS_PER_TASK_MAX } from "@aura/contracts/limits";
import {
    type TaskSpec,
    taskKindSchema,
    taskSpecSchema,
    versionStateSchema,
} from "@aura/contracts/tasks";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for task versions and bundle uploads, run as `aura_app`: row-level security decides which
// versions exist for the caller, and the guard trigger in migration 0012 refuses illegal moves.

const versionRowSchema = z.object({
    id: z.string(),
    org_id: z.string(),
    task_id: z.string(),
    task_kind: taskKindSchema,
    seq: z.number().int(),
    state: versionStateSchema,
    spec: taskSpecSchema.nullable(),
    statement: z.string().nullable(),
    bundle_bytes: z.coerce.number().int().nullable(),
    bundle_sha256: z.instanceof(Uint8Array).nullable(),
    waived: z.boolean(),
    created_by: z.string(),
    created_at: z.date(),
    updated_at: z.date(),
    released_at: z.date().nullable(),
});
export type VersionRow = z.infer<typeof versionRowSchema>;

const SELECT_VERSION = (tx: Transaction) => tx`
    select v.id, v.org_id, v.task_id, t.kind as task_kind, v.seq, v.state, v.spec, v.statement,
           v.bundle_bytes, v.bundle_sha256, v.waived, v.created_by, v.created_at, v.updated_at,
           v.released_at
    from task_versions v join tasks t on t.id = v.task_id`;

export async function getVersion(tx: Transaction, versionId: string): Promise<VersionRow | null> {
    const rows = await tx`${SELECT_VERSION(tx)} where v.id = ${versionId}`;
    return rows[0] === undefined ? null : versionRowSchema.parse(rows[0]);
}

export async function listVersions(tx: Transaction, taskId: string): Promise<VersionRow[]> {
    const rows = await tx`${SELECT_VERSION(tx)} where v.task_id = ${taskId}
        order by v.seq desc limit ${VERSIONS_PER_TASK_MAX}`;
    return rows.map((row) => versionRowSchema.parse(row));
}

// Takes the same lock the guard trigger takes, so two simultaneous creations get consecutive
// numbers instead of one of them failing.
export async function insertVersion(
    tx: Transaction,
    input: { orgId: string; taskId: string; userId: string },
): Promise<string> {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`versions:${input.taskId}`}, 0))`;
    const rows = await tx`
        insert into task_versions (org_id, task_id, seq, created_by)
        select ${input.orgId}, ${input.taskId}, coalesce(max(seq), 0) + 1, ${input.userId}
        from task_versions where task_id = ${input.taskId}
        returning id`;
    return z.object({ id: z.string() }).parse(rows[0]).id;
}

// Only while the version is still editable (the policy enforces the same). The spec is sent as JSON
// (`tx.json`), not as text cast to jsonb, which would store a JSON string instead of an object.
export async function updateContent(
    tx: Transaction,
    versionId: string,
    change: { statement?: string | undefined; spec?: TaskSpec | undefined },
): Promise<boolean> {
    let updated = false;
    if (change.statement !== undefined) {
        const rows = await tx`
            update task_versions set statement = ${change.statement}
            where id = ${versionId} and state in ('draft', 'uploaded') returning id`;
        updated = rows.length === 1;
        if (!updated) return false;
    }
    if (change.spec !== undefined) {
        const rows = await tx`
            update task_versions set spec = ${tx.json(change.spec)}
            where id = ${versionId} and state in ('draft', 'uploaded') returning id`;
        updated = rows.length === 1;
    }
    return updated;
}

// One guarded statement per state move: if someone else moved the version first, no row matches.
export async function moveState(
    tx: Transaction,
    versionId: string,
    from: string,
    to: string,
): Promise<boolean> {
    const rows = await tx`
        update task_versions set state = ${to} where id = ${versionId} and state = ${from}
        returning id`;
    return rows.length === 1;
}

// The bundle is recorded once, together with the move out of draft.
export async function recordBundle(
    tx: Transaction,
    versionId: string,
    bundle: { bytes: number; sha256Hex: string },
): Promise<boolean> {
    const rows = await tx`
        update task_versions
        set state = 'uploaded', bundle_bytes = ${bundle.bytes},
            bundle_sha256 = decode(${bundle.sha256Hex}, 'hex')
        where id = ${versionId} and state = 'draft'
        returning id`;
    return rows.length === 1;
}

const uploadRowSchema = z.object({
    id: z.string(),
    org_id: z.string(),
    task_version_id: z.string(),
    storage_upload_id: z.string(),
    expected_bytes: z.coerce.number().int(),
    expected_sha256: z.instanceof(Uint8Array),
    part_count: z.number().int(),
    expires_at: z.date(),
    finished_at: z.date().nullable(),
});
export type UploadRow = z.infer<typeof uploadRowSchema>;

export async function insertUpload(
    tx: Transaction,
    input: {
        id: string;
        orgId: string;
        versionId: string;
        userId: string;
        storageUploadId: string;
        bytes: number;
        sha256Hex: string;
        partBytes: number;
        partCount: number;
        createdAt: Date;
        expiresAt: Date;
    },
): Promise<void> {
    await tx`
        insert into bundle_uploads (id, org_id, task_version_id, started_by, storage_upload_id,
                                    expected_bytes, expected_sha256, part_bytes, part_count, created_at, expires_at)
        values (${input.id}, ${input.orgId}, ${input.versionId}, ${input.userId},
                ${input.storageUploadId}, ${input.bytes}, decode(${input.sha256Hex}, 'hex'),
                ${input.partBytes}, ${input.partCount}, ${input.createdAt}, ${input.expiresAt})`;
}

export async function getUpload(
    tx: Transaction,
    uploadId: string,
    versionId: string,
): Promise<UploadRow | null> {
    const rows = await tx`
        select id, org_id, task_version_id, storage_upload_id, expected_bytes, expected_sha256,
               part_count, expires_at, finished_at
        from bundle_uploads where id = ${uploadId} and task_version_id = ${versionId}`;
    return rows[0] === undefined ? null : uploadRowSchema.parse(rows[0]);
}

export async function finishUpload(tx: Transaction, uploadId: string, at: Date): Promise<void> {
    await tx`update bundle_uploads set finished_at = ${at} where id = ${uploadId} and finished_at is null`;
}

// An approval counts only if it came from someone other than the creator during the current review
// stint (after the version last entered review), the same rule the database applies on release.
export async function hasApproval(tx: Transaction, versionId: string): Promise<boolean> {
    const rows = await tx`
        select exists (
            select 1 from task_reviews r join task_versions v on v.id = r.task_version_id
            where r.task_version_id = ${versionId} and r.outcome = 'approved'
              and r.reviewer_id <> v.created_by and r.created_at >= v.submitted_at) as approved`;
    return z.object({ approved: z.boolean() }).parse(rows[0]).approved;
}

export async function insertReview(
    tx: Transaction,
    input: {
        orgId: string;
        versionId: string;
        reviewerId: string;
        outcome: string;
        comment: string | null;
    },
): Promise<void> {
    await tx`
        insert into task_reviews (org_id, task_version_id, reviewer_id, outcome, comment)
        values (${input.orgId}, ${input.versionId}, ${input.reviewerId}, ${input.outcome}, ${input.comment})`;
}

// The version that is released now, if any, other than this one.
export async function otherReleasedVersion(
    tx: Transaction,
    taskId: string,
    versionId: string,
): Promise<string | null> {
    const rows = await tx`
        select id from task_versions where task_id = ${taskId} and state = 'released' and id <> ${versionId}`;
    return rows[0] === undefined ? null : z.object({ id: z.string() }).parse(rows[0]).id;
}

export async function recordRelease(
    tx: Transaction,
    input: { versionId: string; from: string; waived: boolean; releasedBy: string; at: Date },
): Promise<boolean> {
    const rows = await tx`
        update task_versions
        set state = 'released', waived = ${input.waived}, released_by = ${input.releasedBy},
            released_at = ${input.at}
        where id = ${input.versionId} and state = ${input.from}
        returning id`;
    return rows.length === 1;
}
