import type { Verdict } from "@aura/contracts/judging";
import { judgeLanguageSchema } from "@aura/contracts/judging";
import { taskSpecSchema } from "@aura/contracts/tasks";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for judging, run as `aura_worker` on behalf of a node whose signature was verified.

const workRowSchema = z.object({
    id: z.string(),
    org_id: z.string(),
    state: z.string(),
    language: judgeLanguageSchema,
    source: z.string(),
    task_version_id: z.string(),
    spec: taskSpecSchema.nullable(),
    bundle_bytes: z.coerce.number().int().nullable(),
    bundle_sha256: z.instanceof(Uint8Array).nullable(),
});
export type WorkRow = z.infer<typeof workRowSchema>;

// The submission behind a judge job, locked so two nodes cannot start it.
export async function lockSubmissionWork(
    tx: Transaction,
    submissionId: string,
): Promise<WorkRow | null> {
    const rows = await tx`
        select s.id, s.org_id, s.state, s.language, s.source, s.task_version_id,
               v.spec, v.bundle_bytes, v.bundle_sha256
        from submissions s join task_versions v on v.id = s.task_version_id and v.org_id = s.org_id
        where s.id = ${submissionId} for update of s`;
    return rows[0] === undefined ? null : workRowSchema.parse(rows[0]);
}

export async function startJudging(
    tx: Transaction,
    submissionId: string,
    nowMs: number,
): Promise<void> {
    await tx`update submissions set state = 'judging', updated_at = ${new Date(nowMs)}
             where id = ${submissionId} and state in ('queued', 'judging')`;
}

// A job went back to the queue: the submission waits for the next node.
export async function backToQueue(
    tx: Transaction,
    submissionId: string,
    nowMs: number,
): Promise<void> {
    await tx`update submissions set state = 'queued', updated_at = ${new Date(nowMs)}
             where id = ${submissionId} and state = 'judging'`;
}

export async function markFailedSystem(
    tx: Transaction,
    submissionId: string,
    nowMs: number,
): Promise<void> {
    await tx`update submissions set state = 'failed_system', judged_at = ${new Date(nowMs)}, updated_at = ${new Date(nowMs)}
             where id = ${submissionId} and state in ('queued', 'judging')`;
}

export async function recordVerdict(
    tx: Transaction,
    input: {
        submissionId: string;
        orgId: string;
        verdict: Verdict;
        score: number;
        nowMs: number;
        tests: ReadonlyArray<{
            testId: string;
            verdict: string;
            cpuMs: number;
            wallMs: number;
            memoryKib: number;
            message: string | null;
        }>;
    },
): Promise<boolean> {
    const at = new Date(input.nowMs);
    const updated = await tx`
        update submissions set state = 'judged', verdict = ${input.verdict}, score = ${input.score},
            judged_at = ${at}, updated_at = ${at}
        where id = ${input.submissionId} and state = 'judging' returning id`;
    if (updated.length === 0) return false;
    for (const test of input.tests) {
        await tx`
            insert into verdict_details (submission_id, org_id, test_id, verdict, cpu_ms, wall_ms, memory_kib, checker_msg)
            values (${input.submissionId}, ${input.orgId}, ${test.testId}, ${test.verdict}, ${test.cpuMs}, ${test.wallMs},
                    ${test.memoryKib}, ${test.message})`;
    }
    return true;
}
