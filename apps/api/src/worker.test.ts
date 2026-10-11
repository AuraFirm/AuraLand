// Goal: the worker runs the right handler for each job, completes what succeeds, retries what throws
// (then gives up after the last attempt), fails unknown kinds for good without retrying, never
// duplicates the recurring jobs, and drives the real housekeeping against a real database.
import { fileURLToPath } from "node:url";
import { withRequestContext } from "@aura/db/context";
import { loadMigrations, migrate } from "@aura/db/migrate";
import { createTestDatabase, type TestDatabase } from "@aura/db/test-helpers";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgJobStore } from "./modules/jobs/queries.ts";
import { enqueueJob } from "./modules/jobs/service.ts";
import { abortExpiredUploads } from "./modules/maintenance/handlers.ts";
import { createMemoryStorage } from "./platform/storage-memory.ts";
import { createMemoryJobStore } from "./sim/job-store.ts";
import { createFakeClock, createSeededRng } from "./sim/world.ts";
import {
    type Handler,
    maintenanceHandlers,
    runOnce,
    scheduleMaintenance,
    type WorkerDeps,
} from "./worker.ts";

const START = 1_800_000_000_000;
const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;

function memoryWorker(handlers: Map<string, Handler>) {
    const clock = createFakeClock(START);
    const rng = createSeededRng(3);
    const store = createMemoryJobStore();
    const deps: WorkerDeps = {
        clock,
        rng,
        logger: pino({ level: "silent" }),
        context: {
            clock,
            storage: createMemoryStorage(clock),
            inTransaction: () => Promise.reject(new Error("no database here")),
        },
        withStore: (work) => work(store),
        handlers,
        queue: "default",
        name: "test-worker",
    };
    return { deps, store, clock, rng };
}

describe("runOnce", () => {
    it("does nothing when the queue is empty", async () => {
        const { deps } = memoryWorker(new Map());
        expect(await runOnce(deps)).toBe(false);
    });

    it("runs the handler for the job's kind and records its result", async () => {
        const seen: string[] = [];
        const { deps, store, rng, clock } = memoryWorker(
            new Map<string, Handler>([
                [
                    "test.work",
                    async (job) => {
                        seen.push(job.id);
                        return { ok: true };
                    },
                ],
            ]),
        );
        const { id } = await enqueueJob(
            { store, clock, rng },
            { kind: "test.work", queue: "default", payload: {} },
        );
        expect(await runOnce(deps)).toBe(true);
        expect(seen).toEqual([id]);
        const job = await store.get(id);
        expect(job?.state).toBe("done");
        expect(job?.result).toEqual({ ok: true });
    });

    it("fails a job nobody can handle for good, without retrying", async () => {
        const { deps, store, rng, clock } = memoryWorker(new Map());
        const { id } = await enqueueJob(
            { store, clock, rng },
            { kind: "test.unknown", queue: "default", payload: {} },
        );
        await runOnce(deps);
        const job = await store.get(id);
        expect(job?.state).toBe("dead");
        expect(job?.attempt).toBe(1);
        expect(job?.lastError).toMatch(/no handler/);
    });
});

describe("runOnce: failures", () => {
    it("retries a throwing handler with backoff and gives up after the last attempt", async () => {
        let calls = 0;
        const { deps, store, rng, clock } = memoryWorker(
            new Map<string, Handler>([
                [
                    "test.flaky",
                    async () => {
                        calls++;
                        throw new Error("boom\u0007");
                    },
                ],
            ]),
        );
        const { id } = await enqueueJob(
            { store, clock, rng },
            { kind: "test.flaky", queue: "default", payload: {}, maxAttempts: 3 },
        );
        await runOnce(deps);
        expect((await store.get(id))?.state).toBe("ready");
        // Not before the backoff has passed.
        expect(await runOnce(deps)).toBe(false);
        clock.advance(6_000);
        await runOnce(deps);
        clock.advance(11_000);
        await runOnce(deps);
        const job = await store.get(id);
        expect(calls).toBe(3);
        expect(job?.state).toBe("dead");
        expect(job?.lastError).toBe("boom ");
    });
});

let db: TestDatabase;
beforeAll(async () => {
    db = await createTestDatabase(4);
    const directory = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));
    await migrate(db.database.sql, loadMigrations(directory));
});
afterAll(async () => {
    await db.drop();
});

function realWorker() {
    const clock = createFakeClock(START);
    const inTransaction = <T>(work: Parameters<typeof withRequestContext<T>>[2]) =>
        withRequestContext(db.database.sql, WORKER, work);
    const deps: WorkerDeps = {
        clock,
        rng: createSeededRng(11),
        logger: pino({ level: "silent" }),
        context: { clock, storage: createMemoryStorage(clock), inTransaction },
        withStore: (work) => inTransaction((tx) => work(createPgJobStore(tx))),
        handlers: maintenanceHandlers(),
        queue: "default",
        name: "real-worker",
    };
    return { deps, clock };
}

describe("scheduling and the real housekeeping", () => {
    it("puts each recurring job on the queue once, however often it is asked", async () => {
        const { deps } = realWorker();
        await scheduleMaintenance(deps);
        await scheduleMaintenance(deps);
        const rows = await db.database
            .sql`select kind from jobs where state = 'ready' order by kind`;
        expect(rows.map((r) => r["kind"])).toEqual([
            "maintenance.abort_uploads",
            "maintenance.cleanup",
        ]);
    });

    it("runs both housekeeping jobs to completion against the database", async () => {
        const { deps } = realWorker();
        await db.database.sql`delete from jobs`;
        await scheduleMaintenance(deps);
        expect(await runOnce(deps)).toBe(true);
        expect(await runOnce(deps)).toBe(true);
        expect(await runOnce(deps)).toBe(false);
        const rows = await db.database.sql`select state from jobs where kind like 'maintenance.%'`;
        expect(rows.every((r) => r["state"] === "done")).toBe(true);
    });
});

async function seedVersion() {
    const { sql } = db.database;
    const user = "018f0000-0000-7000-8000-000000000b01";
    await sql`insert into users (id, email) values (${user}, 'abort@example.com')`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'abort-org', 'x') returning id`;
    await sql`insert into memberships (org_id, user_id, role) values (${org?.id ?? ""}, ${user}, 'owner')`;
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, title, created_by) values (${org?.id ?? ""}, 'abort-task', 'function', 'x', ${user}) returning id`;
    const [version] = await sql<
        { id: string }[]
    >`insert into task_versions (org_id, task_id, seq, created_by) values (${org?.id ?? ""}, ${task?.id ?? ""}, 1, ${user}) returning id`;
    return { user, org: org?.id ?? "", version: version?.id ?? "" };
}

describe("upload housekeeping", () => {
    it("aborts an expired upload in storage and closes it, leaving a live one alone", async () => {
        const { sql } = db.database;
        const seed = await seedVersion();
        const { deps, clock } = realWorker();
        const storage = createMemoryStorage(clock);
        const context = { ...deps.context, storage };
        const open = async (id: string, createdMs: number) => {
            const uploadId = await storage.beginMultipart(`uploads/${seed.org}/${id}`);
            await sql`insert into bundle_uploads (id, org_id, task_version_id, started_by, storage_upload_id, expected_bytes,
                expected_sha256, part_bytes, part_count, created_at, expires_at)
                values (${id}, ${seed.org}, ${seed.version}, ${seed.user}, ${uploadId}, 10, ${Buffer.alloc(32, 1)}, 8388608, 1,
                ${new Date(createdMs)}, ${new Date(createdMs + 3_600_000)})`;
        };
        await open("018f0000-0000-7000-8000-000000000c01", START - 2 * 3_600_000);
        await open("018f0000-0000-7000-8000-000000000c02", START - 60_000);
        expect(storage.uploadCount()).toBe(2);
        expect(await abortExpiredUploads(context)).toEqual({ aborted: 1 });
        expect(storage.uploadCount()).toBe(1);
        const rows =
            await sql`select finished_at is not null as closed from bundle_uploads order by id`;
        expect(rows.map((r) => r["closed"])).toEqual([true, false]);
    });
});
