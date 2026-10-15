import { assert } from "@aura/contracts/assert";
import { RATING_TICK_MS, rateNextContest } from "./modules/contests/rating-tick.ts";
import {
    createPostgresScoreboardPort,
    refreshScoreboards,
} from "./modules/contests/scoreboard-tick.ts";
import { advanceContests, CONTEST_TICK_MS } from "./modules/contests/tick.ts";
import { failDeadRuns } from "./modules/environments/tick.ts";
import { generateOralQuestions } from "./modules/exams/oral-tick.ts";
import { advanceExams } from "./modules/exams/tick.ts";
import { HEARTBEAT_INTERVAL_MS } from "./modules/jobs/limits.ts";
import type { JobRecord } from "./modules/jobs/rules.ts";
import {
    completeJob,
    enqueueJob,
    failJob,
    heartbeatJob,
    leaseJob,
} from "./modules/jobs/service.ts";
import type { JobStore } from "./modules/jobs/store.ts";
import {
    ABORT_UPLOADS_KIND,
    abortExpiredUploads,
    CLEANUP_KIND,
    cleanupExpired,
    type HandlerContext,
} from "./modules/maintenance/handlers.ts";
import { buildDelivery, DELIVERY_BUILD_KIND } from "./modules/orders/handlers.ts";
import { PASSPORT_TICK_MS, runPassportTick } from "./modules/passport/tick.ts";
import type { Clock } from "./platform/clock.ts";
import type { LlmProvider } from "./platform/llm.ts";
import type { Logger } from "./platform/log.ts";
import type { Rng } from "./platform/rng.ts";
import type { Signer } from "./platform/signer.ts";

// The worker: takes jobs from the queue and runs their handlers. One entry point of the API package
// (AURA_ROLE=worker). Leasing, completing and failing each use their own short transaction; the
// handler itself runs outside any queue transaction, with a heartbeat keeping the lease alive.

export type Handler = (job: JobRecord, context: HandlerContext) => Promise<unknown>;

export interface WorkerDeps {
    readonly clock: Clock;
    readonly rng: Rng;
    readonly logger: Logger;
    readonly context: HandlerContext;
    // Runs queue operations in a transaction as the worker role.
    readonly withStore: <T>(work: (store: JobStore) => Promise<T>) => Promise<T>;
    readonly handlers: ReadonlyMap<string, Handler>;
    readonly queue: string;
    readonly name: string;
    // Absent until a provider account exists (owner item F41): oral defence requests then wait, pending.
    readonly llm?: LlmProvider;
    // Absent in production until a KMS signer exists (F62): then no credential is issued or published.
    readonly passport?: { readonly signer: Signer; readonly publicOrigin: string };
}

export function maintenanceHandlers(): Map<string, Handler> {
    return new Map<string, Handler>([
        [CLEANUP_KIND, (_job, context) => cleanupExpired(context)],
        [ABORT_UPLOADS_KIND, (_job, context) => abortExpiredUploads(context)],
        [DELIVERY_BUILD_KIND, (job, context) => buildDelivery(job.payload, context)],
    ]);
}

const queueDeps = (deps: WorkerDeps, store: JobStore) => ({
    store,
    clock: deps.clock,
    rng: deps.rng,
});

// Leases and runs at most one job. Returns false when the queue had nothing.
export async function runOnce(deps: WorkerDeps): Promise<boolean> {
    const job = await deps.withStore((store) =>
        leaseJob(queueDeps(deps, store), deps.queue, deps.name),
    );
    if (job === null) return false;
    const handler = deps.handlers.get(job.kind);
    if (handler === undefined) {
        // Nobody here knows this kind; retrying cannot help, and another worker would say the same.
        await deps.withStore((store) =>
            failJob(queueDeps(deps, store), {
                id: job.id,
                epoch: job.leaseEpoch,
                error: `no handler for ${job.kind}`,
                retryable: false,
            }),
        );
        deps.logger.error({ job_id: job.id, kind: job.kind }, "job kind has no handler");
        return true;
    }
    const beat = setInterval(() => {
        void deps
            .withStore((store) => heartbeatJob(queueDeps(deps, store), job.id, job.leaseEpoch))
            .catch((error: unknown) =>
                deps.logger.warn({ err: error, job_id: job.id }, "heartbeat failed"),
            );
    }, HEARTBEAT_INTERVAL_MS);
    try {
        const result = await handler(job, deps.context);
        const accepted = await deps.withStore((store) =>
            completeJob(queueDeps(deps, store), job.id, job.leaseEpoch, result ?? null),
        );
        if (!accepted) deps.logger.warn({ job_id: job.id }, "result refused: the lease was lost");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger.error({ job_id: job.id, kind: job.kind, err: error }, "job failed");
        await deps.withStore((store) =>
            failJob(queueDeps(deps, store), {
                id: job.id,
                epoch: job.leaseEpoch,
                error: message,
                retryable: true,
            }),
        );
    } finally {
        clearInterval(beat);
    }
    return true;
}

// Puts the recurring housekeeping jobs on the queue. Safe to call often: an unfinished job of the same
// kind is never duplicated.
export async function scheduleMaintenance(deps: WorkerDeps): Promise<void> {
    for (const kind of [CLEANUP_KIND, ABORT_UPLOADS_KIND]) {
        await deps.withStore((store) =>
            enqueueJob(queueDeps(deps, store), {
                kind,
                queue: deps.queue,
                payload: {},
                dedupeKey: kind,
                priority: 8,
            }),
        );
    }
}

const IDLE_WAIT_MS = 2_000;
const SCHEDULE_EVERY_MS = 5 * 60_000;

export interface RunningWorker {
    stop(): Promise<void>;
}

// Questions for oral defence requests, when there is a model to ask. A failure here never stops the other ticks.
async function tickOralDefence(deps: WorkerDeps): Promise<void> {
    if (deps.llm === undefined) return;
    try {
        await generateOralQuestions({
            clock: deps.context.clock,
            llm: deps.llm,
            inTransaction: deps.context.inTransaction,
        });
    } catch (error) {
        deps.logger.error({ err: error }, "oral defence tick error");
    }
}

// Credentials from finished events and the static documents that verify them, at their own slower pace.
async function tickPassport(deps: WorkerDeps, due: { nextAtMs: number }): Promise<void> {
    if (deps.passport === undefined || deps.clock.nowUnixMs() < due.nextAtMs) return;
    due.nextAtMs = deps.clock.nowUnixMs() + PASSPORT_TICK_MS;
    try {
        await runPassportTick({
            clock: deps.clock,
            rng: deps.rng,
            signer: deps.passport.signer,
            storage: deps.context.storage,
            publicOrigin: deps.passport.publicOrigin,
            inTransaction: deps.context.inTransaction,
        });
    } catch (error) {
        deps.logger.error({ err: error }, "passport tick error");
    }
}

export function startWorker(deps: WorkerDeps): RunningWorker {
    let stopping = false;
    const loop = (async () => {
        let nextSchedule = 0;
        // unbounded: the worker runs until the process is told to stop
        while (!stopping) {
            try {
                if (deps.clock.nowUnixMs() >= nextSchedule) {
                    await scheduleMaintenance(deps);
                    nextSchedule = deps.clock.nowUnixMs() + SCHEDULE_EVERY_MS;
                }
                const ran = await runOnce(deps);
                if (!ran) await new Promise((resolve) => setTimeout(resolve, IDLE_WAIT_MS));
            } catch (error) {
                deps.logger.error({ err: error }, "worker loop error");
                await new Promise((resolve) => setTimeout(resolve, IDLE_WAIT_MS));
            }
        }
    })();
    // The contest clock ticks on its own pace, apart from the job queue: a long job must not delay it.
    const scoreboards = createPostgresScoreboardPort(deps.context);
    const passportDue = { nextAtMs: 0 };
    const ticks = (async () => {
        // unbounded: the tick runs until the process is told to stop
        while (!stopping) {
            try {
                await advanceContests(deps.context);
            } catch (error) {
                deps.logger.error({ err: error }, "contest tick error");
            }
            try {
                await advanceExams(deps.context);
                await failDeadRuns(deps.context);
            } catch (error) {
                deps.logger.error({ err: error }, "exam tick error");
            }
            await tickOralDefence(deps);
            await tickPassport(deps, passportDue);
            try {
                await refreshScoreboards(scoreboards, deps.context.clock);
            } catch (error) {
                deps.logger.error({ err: error }, "scoreboard tick error");
            }
            await new Promise((resolve) => setTimeout(resolve, CONTEST_TICK_MS));
        }
    })();
    // Rating is slow and rare, so it has its own loop: a long rating must not delay the contest clock.
    const ratings = (async () => {
        // unbounded: the rating loop runs until the process is told to stop
        while (!stopping) {
            try {
                await rateNextContest(deps.context, deps.context.clock);
            } catch (error) {
                deps.logger.error({ err: error }, "rating error");
            }
            await new Promise((resolve) => setTimeout(resolve, RATING_TICK_MS));
        }
    })();
    return {
        async stop() {
            assert(!stopping, "stop is called once");
            stopping = true;
            await Promise.all([loop, ticks, ratings]);
        },
    };
}
