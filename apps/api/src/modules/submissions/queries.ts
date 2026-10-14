import { createHash } from "node:crypto";
import {
    judgeLanguageSchema,
    submissionStateSchema,
    testVerdictSchema,
    verdictSchema,
} from "@aura/contracts/judging";
import {
    CONTEST_JUDGE_QUEUE_READY_MAX,
    JUDGE_QUEUE_READY_MAX,
    SUBMISSION_PAGE_SIZE_MAX,
} from "@aura/contracts/limits";
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

// A submission to a contest problem, created by the database function of migration 0035 (which takes the
// injected clock and checks registration, window, problem, language and the interval). The refusal codes
// are those the function documents.
export type ContestSubmissionOutcome =
    | { readonly kind: "created"; readonly id: string }
    | {
          readonly kind: "refused";
          readonly why: "closed" | "language" | "too_soon" | "queue_full" | "too_large" | "unknown";
          readonly retryAfterS: number | null;
      };

export async function createContestSubmission(
    tx: Transaction,
    input: { contestId: string; label: string; language: string; source: string; nowMs: number },
): Promise<ContestSubmissionOutcome> {
    try {
        const rows =
            await tx`select create_contest_submission(${input.contestId}, ${input.label}, ${input.language},
            ${input.source}, ${new Date(input.nowMs)}, ${CONTEST_JUDGE_QUEUE_READY_MAX}) as id`;
        return { kind: "created", id: z.object({ id: z.string() }).parse(rows[0]).id };
    } catch (error) {
        const code =
            typeof error === "object" && error !== null && "code" in error ? error.code : null;
        const hint =
            typeof error === "object" && error !== null && "hint" in error
                ? Number(error.hint)
                : null;
        const known = refusalOf(code);
        if (known === null) throw error;
        return { kind: "refused", why: known, retryAfterS: Number.isFinite(hint) ? hint : null };
    }
}

export type RejudgeOutcome =
    | { kind: "queued" }
    | { kind: "refused"; why: "unknown" | "not_now" | "queue_full" };

// Asks for a rejudge. The database function decides who may (the host's owners and admins), whether the
// submission and contest allow it, and whether the judge queue has room; `contestId` only guards the
// address, so a submission of another contest is "unknown" rather than rejudged by accident.
export async function rejudgeContestSubmission(
    tx: Transaction,
    input: { contestId: string; submissionId: string; nowMs: number },
): Promise<RejudgeOutcome> {
    const own = await tx`select 1 as found from submissions
        where id = ${input.submissionId} and context_id = ${input.contestId}`;
    if (own.length === 0) return { kind: "refused", why: "unknown" };
    try {
        await tx`select rejudge_contest_submission(${input.submissionId}, ${new Date(input.nowMs)},
            ${CONTEST_JUDGE_QUEUE_READY_MAX})`;
        return { kind: "queued" };
    } catch (error) {
        const code =
            typeof error === "object" && error !== null && "code" in error ? error.code : null;
        if (code === "P0002") return { kind: "refused", why: "unknown" };
        if (code === "55000") return { kind: "refused", why: "not_now" };
        if (code === "53400") return { kind: "refused", why: "queue_full" };
        throw error;
    }
}

const REFUSALS: Readonly<
    Record<string, "closed" | "language" | "too_soon" | "queue_full" | "too_large" | "unknown">
> = {
    "55000": "closed",
    "22023": "language",
    "54000": "too_soon",
    "53400": "queue_full",
    "22001": "too_large",
    P0002: "unknown",
};
const refusalOf = (code: unknown) => (typeof code === "string" ? (REFUSALS[code] ?? null) : null);

export async function listMineInContest(
    tx: Transaction,
    input: { contestId: string; userId: string; cursor: string | null; limit: number },
): Promise<{ rows: SubmissionRow[]; hasMore: boolean }> {
    const rows = await tx`select ${COLUMNS(tx)} from submissions
        where context_id = ${input.contestId} and user_id = ${input.userId}
          and ${input.cursor === null ? tx`true` : tx`id < ${input.cursor}`}
        order by id desc limit ${input.limit + 1}`;
    const parsed = rows.map((row) => submissionRowSchema.parse(row));
    return { rows: parsed.slice(0, input.limit), hasMore: parsed.length > input.limit };
}
