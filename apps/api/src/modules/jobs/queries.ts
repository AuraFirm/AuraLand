import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import { SWEEP_BATCH_MAX } from "./limits.ts";
import { backoffMs, cleanError, failureOutcome, type JobRecord, type NewJob } from "./rules.ts";
import type { JobStore } from "./store.ts";

// The PostgreSQL job store. Each method is one atomic step in the caller's transaction (the worker
// opens one per call). Leasing uses `FOR UPDATE SKIP LOCKED`, so workers never wait for each other
// and never take the same job; fencing is the epoch compared in the same statement that writes.

const rowSchema = z.object({
    id: z.string(),
    kind: z.string(),
    org_id: z.string().nullable(),
    payload: z.unknown(),
    queue: z.string(),
    priority: z.number().int(),
    state: z.enum(["ready", "leased", "done", "dead"]),
    attempt: z.number().int(),
    max_attempts: z.number().int(),
    run_after: z.date(),
    lease_owner: z.string().nullable(),
    lease_epoch: z.coerce.number().int(),
    lease_expires_at: z.date().nullable(),
    dedupe_key: z.string().nullable(),
    result: z.unknown(),
    last_error: z.string().nullable(),
    created_at: z.date(),
    updated_at: z.date(),
});

function toRecord(row: unknown): JobRecord {
    const r = rowSchema.parse(row);
    return {
        id: r.id,
        kind: r.kind,
        orgId: r.org_id,
        payload: r.payload,
        queue: r.queue,
        priority: r.priority,
        state: r.state,
        attempt: r.attempt,
        maxAttempts: r.max_attempts,
        runAfterMs: r.run_after.getTime(),
        leaseOwner: r.lease_owner,
        leaseEpoch: r.lease_epoch,
        leaseExpiresAtMs: r.lease_expires_at?.getTime() ?? null,
        dedupeKey: r.dedupe_key,
        result: r.result ?? null,
        lastError: r.last_error,
        createdAtMs: r.created_at.getTime(),
        updatedAtMs: r.updated_at.getTime(),
    };
}

const at = (ms: number) => new Date(ms);

// Payloads and results are JSON by contract; parsing proves it before the driver sees them.
type JsonValue = Parameters<Transaction["json"]>[0];
const jsonSchema: z.ZodType<JsonValue> = z.json();
const asJson = (value: unknown): JsonValue => jsonSchema.parse(value);

async function enqueue(tx: Transaction, job: NewJob, nowMs: number) {
    const rows = await tx`
        insert into jobs (id, kind, org_id, payload, queue, priority, max_attempts, run_after,
                          dedupe_key, created_at, updated_at)
        values (${job.id}, ${job.kind}, ${job.orgId}, ${tx.json(asJson(job.payload))}, ${job.queue},
                ${job.priority}, ${job.maxAttempts}, ${at(job.runAfterMs)}, ${job.dedupeKey},
                ${at(nowMs)}, ${at(nowMs)})
        on conflict (queue, dedupe_key) where dedupe_key is not null and state in ('ready', 'leased')
        do nothing
        returning id`;
    if (rows[0] !== undefined) return { id: job.id, created: true };
    const existing = await tx`
        select id from jobs where queue = ${job.queue} and dedupe_key = ${job.dedupeKey}
          and state in ('ready', 'leased')`;
    return { id: z.object({ id: z.string() }).parse(existing[0]).id, created: false };
}

async function sweep(tx: Transaction, nowMs: number) {
    const expired = await tx`
        select id, attempt, max_attempts from jobs
        where state = 'leased' and lease_expires_at <= ${at(nowMs)}
        order by lease_expires_at, id limit ${SWEEP_BATCH_MAX} for update skip locked`;
    let retried = 0;
    let dead = 0;
    for (const row of expired) {
        const job = z
            .object({ id: z.string(), attempt: z.number().int(), max_attempts: z.number().int() })
            .parse(row);
        if (failureOutcome(job.attempt, job.max_attempts, true) === "retry") {
            await tx`
                update jobs set state = 'ready', lease_owner = null, lease_expires_at = null,
                    run_after = ${at(nowMs + backoffMs(job.attempt))}, last_error = 'lease expired',
                    updated_at = ${at(nowMs)}
                where id = ${job.id}`;
            retried++;
        } else {
            await tx`
                update jobs set state = 'dead', lease_owner = null, lease_expires_at = null,
                    last_error = 'lease expired on the last attempt', updated_at = ${at(nowMs)}
                where id = ${job.id}`;
            dead++;
        }
    }
    return { retried, dead };
}

async function lease(tx: Transaction, queue: string, owner: string, nowMs: number, ttlMs: number) {
    await sweep(tx, nowMs);
    const rows = await tx`
        update jobs set state = 'leased', attempt = attempt + 1, lease_owner = ${owner},
            lease_epoch = lease_epoch + 1, lease_expires_at = ${at(nowMs + ttlMs)},
            updated_at = ${at(nowMs)}
        where id = (select id from jobs where queue = ${queue} and state = 'ready'
                    and run_after <= ${at(nowMs)}
                    order by priority, run_after, id for update skip locked limit 1)
        returning *`;
    return rows[0] === undefined ? null : toRecord(rows[0]);
}

async function fail(
    tx: Transaction,
    input: { id: string; epoch: number; error: string; retryable: boolean; nowMs: number },
) {
    const rows = await tx`
        select attempt, max_attempts from jobs
        where id = ${input.id} and lease_epoch = ${input.epoch} and state = 'leased' for update`;
    if (rows[0] === undefined) return "stale" as const;
    const job = z
        .object({ attempt: z.number().int(), max_attempts: z.number().int() })
        .parse(rows[0]);
    const outcome = failureOutcome(job.attempt, job.max_attempts, input.retryable);
    const error = cleanError(input.error);
    if (outcome === "retry") {
        await tx`
            update jobs set state = 'ready', lease_owner = null, lease_expires_at = null,
                run_after = ${at(input.nowMs + backoffMs(job.attempt))}, last_error = ${error},
                updated_at = ${at(input.nowMs)}
            where id = ${input.id}`;
        return "retried" as const;
    }
    await tx`
        update jobs set state = 'dead', lease_owner = null, lease_expires_at = null,
            last_error = ${error}, updated_at = ${at(input.nowMs)}
        where id = ${input.id}`;
    return "dead" as const;
}

export function createPgJobStore(tx: Transaction): JobStore {
    return {
        enqueue: (job, nowMs) => enqueue(tx, job, nowMs),
        lease: (queue, owner, nowMs, ttlMs) => lease(tx, queue, owner, nowMs, ttlMs),
        async heartbeat(id, epoch, nowMs, ttlMs) {
            const rows = await tx`
                update jobs set lease_expires_at = ${at(nowMs + ttlMs)}, updated_at = ${at(nowMs)}
                where id = ${id} and lease_epoch = ${epoch} and state = 'leased' returning id`;
            return rows.length === 1;
        },
        async complete(id, epoch, result, nowMs) {
            const rows = await tx`
                update jobs set state = 'done', result = ${tx.json(asJson(result))},
                    lease_owner = null, lease_expires_at = null, updated_at = ${at(nowMs)}
                where id = ${id} and lease_epoch = ${epoch} and state = 'leased' returning id`;
            return rows.length === 1;
        },
        fail: (input) => fail(tx, input),
        sweep: (nowMs) => sweep(tx, nowMs),
        async get(id) {
            const rows = await tx`select * from jobs where id = ${id}`;
            return rows[0] === undefined ? null : toRecord(rows[0]);
        },
    };
}
