import { createHash } from "node:crypto";
import {
    judgeLanguageSchema,
    submissionStateSchema,
    testVerdictSchema,
    verdictSchema,
} from "@aura/contracts/judging";
import { JUDGE_QUEUE_READY_MAX, SUBMISSION_PAGE_SIZE_MAX } from "@aura/contracts/limits";
import { taskSpecSchema } from "@aura/contracts/tasks";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for submissions, run as `aura_app`: row-level security decides who sees which submission.

const versionForSubmissionSchema = z.object({
    id: z.string(),
    org_id: z.string(),
    task_id: z.string(),
    state: z.string(),
    spec: taskSpecSchema.nullable(),
});
export type VersionForSubmission = z.infer<typeof versionForSubmissionSchema>;

// The version a submission would go to, as the caller can see it.
export async function versionForSubmission(
    tx: Transaction,
    versionId: string,
): Promise<VersionForSubmission | null> {
    const rows =
        await tx`select id, org_id, task_id, state, spec from task_versions where id = ${versionId}`;
    return rows[0] === undefined ? null : versionForSubmissionSchema.parse(rows[0]);
}

const submissionRowSchema = z.object({
    id: z.string(),
    org_id: z.string(),
    user_id: z.string(),
    task_version_id: z.string(),
    language: judgeLanguageSchema,
    source: z.string(),
    state: submissionStateSchema,
    verdict: verdictSchema.nullable(),
    score: z.coerce.number().nullable(),
    created_at: z.date(),
    judged_at: z.date().nullable(),
});
export type SubmissionRow = z.infer<typeof submissionRowSchema>;

const COLUMNS = (tx: Transaction) =>
    tx`id, org_id, user_id, task_version_id, language, source, state, verdict, score, created_at, judged_at`;

export async function insertSubmission(
    tx: Transaction,
    input: {
        orgId: string;
        userId: string;
        versionId: string;
        language: string;
        source: string;
        nowMs: number;
    },
): Promise<string> {
    const bytes = Buffer.byteLength(input.source);
    const at = new Date(input.nowMs);
    const rows = await tx`
        insert into submissions (org_id, user_id, task_version_id, language, source, source_sha256, source_bytes, created_at, updated_at)
        values (${input.orgId}, ${input.userId}, ${input.versionId}, ${input.language}, ${input.source},
                ${createHash("sha256").update(input.source).digest()}, ${bytes}, ${at}, ${at})
        returning id`;
    return z.object({ id: z.string() }).parse(rows[0]).id;
}

// Puts the submission on the judge queue inside the same transaction. False when the queue is full.
export async function enqueueForJudging(
    tx: Transaction,
    submissionId: string,
    nowMs: number,
): Promise<boolean> {
    try {
        await tx`select enqueue_judge_job(${submissionId}, ${new Date(nowMs)}, ${JUDGE_QUEUE_READY_MAX})`;
        return true;
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "53400"
        )
            return false;
        throw error;
    }
}

export async function getSubmission(tx: Transaction, id: string): Promise<SubmissionRow | null> {
    const rows = await tx`select ${COLUMNS(tx)} from submissions where id = ${id}`;
    return rows[0] === undefined ? null : submissionRowSchema.parse(rows[0]);
}

// The caller's own submissions to one version, newest first (ids are UUIDv7, so they sort by time).
export async function listMine(
    tx: Transaction,
    userId: string,
    versionId: string,
    cursor: string | null,
    limit: number,
): Promise<{ rows: SubmissionRow[]; hasMore: boolean }> {
    const pageSize = Math.min(limit, SUBMISSION_PAGE_SIZE_MAX);
    const rows = await tx`
        select ${COLUMNS(tx)} from submissions
        where user_id = ${userId} and task_version_id = ${versionId} and (${cursor}::uuid is null or id < ${cursor}::uuid)
        order by id desc limit ${pageSize + 1}`;
    const parsed = rows.map((row) => submissionRowSchema.parse(row));
    return { rows: parsed.slice(0, pageSize), hasMore: parsed.length > pageSize };
}

const resultRowSchema = z.object({
    test_id: z.string(),
    verdict: testVerdictSchema,
    cpu_ms: z.number().int(),
    wall_ms: z.number().int(),
    memory_kib: z.number().int(),
});
export type ResultRow = z.infer<typeof resultRowSchema>;

// Per-test results without checker messages: the message can quote jury data on hidden tests.
export async function testResults(tx: Transaction, submissionId: string): Promise<ResultRow[]> {
    const rows = await tx`
        select test_id, verdict, cpu_ms, wall_ms, memory_kib from verdict_details
        where submission_id = ${submissionId} order by test_id limit 1000`;
    return rows.map((row) => resultRowSchema.parse(row));
}
