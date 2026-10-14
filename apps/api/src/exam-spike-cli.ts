import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { parseArgs } from "node:util";
import { encodeId } from "@aura/contracts/ids";
import { createMigratedTestDatabase, type TestDatabase } from "@aura/db/test-helpers";
import { out, PORT, sleep, startService, waitUntilListening } from "./dev-run-support.ts";

// Usage: node apps/api/src/exam-spike-cli.ts [--users=2000] [--start-seconds=20] [--work-seconds=60]
//        [--save-seconds=10] [--report-file=path]
// (needs: pnpm build, the local compose services.)
//
// The exam load run of docs/kit/10 section 7, SCALED to one development machine: a real API and worker over real
// HTTP and a real PostgreSQL, an open exam with a roster, then
//   1. the start spike: every person joins, agrees and starts inside `start-seconds`;
//   2. the working phase: every person saves a growing draft every `save-seconds` and sends telemetry batches;
//   3. everyone hands in at once;
//   4. the check that matters: every save the server acknowledged is stored (the highest acknowledged number of
//      each person equals the highest stored), and every handed-in sitting became one judged-queue entry.
// There is NO judge here, so verdict latency is not measured. The numbers describe this machine; they are
// evidence of shape and headroom, not a capacity claim.

const { values: flags } = parseArgs({
    options: {
        users: { type: "string", default: "2000" },
        "start-seconds": { type: "string", default: "20" },
        "work-seconds": { type: "string", default: "60" },
        "save-seconds": { type: "string", default: "10" },
        "report-file": { type: "string", default: "" },
    },
});
const USERS = Number(flags["users"]);
const START_S = Number(flags["start-seconds"]);
const WORK_S = Number(flags["work-seconds"]);
const SAVE_S = Number(flags["save-seconds"]);
const REQUEST_TIMEOUT_MS = 30_000;
const TELEMETRY_EVERY_SAVES = 3;
const QUEUE_WAIT_S_MAX = 120; // the run fails, not hangs, if the queue never drains
const SPEC = {
    spec_version: 1,
    kind: "algorithmic",
    title: "Sum of two numbers",
    time_limit_ms: 1000,
    memory_limit_kib: 262144,
    output_limit_kib: 1024,
    languages: ["cpp", "python3"],
    scoring: { type: "binary", subtasks: [] },
    tests: [{ id: "001", group: "all", points: 100, is_sample: true }],
    checker: { type: "exact" },
    license: { owner: "Acme", terms: "internal use" },
    provenance: { author: "Alice", created: "2026-10-10", generated_with_ai: false },
};

interface Sample {
    readonly kind: string;
    readonly status: number;
    readonly ms: number;
}
const samples: Sample[] = [];
const agent = new Agent({ keepAlive: true, maxSockets: 512 });

interface Reply {
    readonly status: number;
    readonly body: string;
}

function call(method: string, path: string, session: string, body?: unknown): Promise<Reply> {
    const started = performance.now();
    return new Promise<Reply>((resolve) => {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const headers = {
            cookie: `aura_session=${session}`,
            "x-aura-request": "1",
            origin: `http://localhost:${PORT}`,
            "sec-fetch-site": "same-origin",
            ...(payload
                ? { "content-type": "application/json", "content-length": payload.length }
                : {}),
        };
        const req = request(
            { host: "127.0.0.1", port: PORT, path, method, agent, headers },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString(),
                    }),
                );
            },
        );
        req.on("error", () => resolve({ status: 0, body: "" }));
        // A request that never answers is an error to count, not a reason for the run to hang.
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy();
            resolve({ status: 0, body: "" });
        });
        if (payload) req.write(payload);
        req.end();
    }).then((reply) => {
        const kind = `${method} ${path.replace(/exm_[0-9a-f-]+/, ":exam")}`;
        samples.push({ kind, status: reply.status, ms: performance.now() - started });
        return reply;
    });
}

interface World {
    readonly exam: string; // public id
    readonly sessions: readonly string[];
    readonly emails: readonly string[];
}

async function seed(database: TestDatabase): Promise<World> {
    const { sql } = database.database;
    const [host] = await sql<{ id: string }[]>`insert into orgs (kind, slug, name)
        values ('university', 'spike-uni', 'Spike University') returning id`;
    const hostId = host?.id ?? "";
    const [maker] = await sql<{ id: string }[]>`insert into users (email, email_verified_at)
        values ('maker@spike.test', now()) returning id`;
    const [releaser] = await sql<{ id: string }[]>`insert into users (email, email_verified_at)
        values ('releaser@spike.test', now()) returning id`;
    const makerId = maker?.id ?? "";
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${hostId}, 'spike-task', 'algorithmic', 'private', 'Sum', ${makerId}) returning id`;
    await sql`alter table task_versions disable trigger task_versions_guard`;
    const [version] = await sql<{ id: string }[]>`insert into task_versions
        (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
        values (${hostId}, ${task?.id ?? ""}, 1, 'released', ${sql.json(SPEC)}, 'Add the numbers.', 10, ${randomBytes(32)}, ${makerId}, ${releaser?.id ?? ""}, now(), true, now()) returning id`;
    await sql`alter table task_versions enable trigger task_versions_guard`;
    const [exam] = await sql<{ id: string }[]>`insert into exams
        (org_id, title, mode, duration_s, window_start, window_end, created_by)
        values (${hostId}, 'Spike exam', 'ai_free', 3600, now() - interval '5 minutes', now() + interval '3 hours', ${makerId}) returning id`;
    const examId = exam?.id ?? "";
    await sql`insert into exam_problems (exam_id, org_id, label, task_version_id, task_org_id, points, auto_percent)
        values (${examId}, ${hostId}, 'A', ${version?.id ?? ""}, ${hostId}, 100, 100)`;
    for (const state of ["scheduled", "open"])
        await sql`update exams set state = ${state} where id = ${examId}`;
    return people(database, { hostId, examId });
}

async function people(
    database: TestDatabase,
    ids: { hostId: string; examId: string },
): Promise<World> {
    const { sql } = database.database;
    const emails = Array.from({ length: USERS }, (_, i) => `u${i}@spike.test`);
    const sessions: string[] = [];
    const BATCH = 500;
    for (let from = 0; from < USERS; from += BATCH) {
        const mine = emails.slice(from, from + BATCH);
        const rows = await sql<{ id: string }[]>`insert into users
            ${sql(
                mine.map((email) => ({ email, email_verified_at: new Date() })),
                "email",
                "email_verified_at",
            )} returning id`;
        const tokens = rows.map(() => randomBytes(32).toString("base64url"));
        await sql`insert into sessions ${sql(
            rows.map((row, i) => ({
                user_id: row.id,
                token_hash: createHash("sha256")
                    .update(tokens[i] ?? "")
                    .digest(),
                auth_method: "email_code",
                privileged: false,
                created_at: new Date(),
                last_seen_at: new Date(),
                idle_expires_at: new Date(Date.now() + 7 * 86_400_000),
                absolute_expires_at: new Date(Date.now() + 30 * 86_400_000),
            })),
        )}`;
        await sql`insert into exam_roster ${sql(mine.map((email, i) => ({ exam_id: ids.examId, org_id: ids.hostId, email, name: `Person ${from + i}` })))}`;
        sessions.push(...tokens);
    }
    return { exam: encodeId("exm", ids.examId), sessions, emails };
}

const percentile = (sorted: readonly number[], q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

function summary() {
    return [...new Set(samples.map((s) => s.kind))].sort().map((kind) => {
        const mine = samples.filter((s) => s.kind === kind);
        const ms = mine.map((s) => s.ms).sort((a, b) => a - b);
        return {
            kind,
            count: mine.length,
            errors: mine.filter((s) => s.status < 200 || s.status >= 300).length,
            statuses: [...new Set(mine.map((s) => s.status))].sort().join("/"),
            p50: Math.round(percentile(ms, 0.5)),
            p95: Math.round(percentile(ms, 0.95)),
            p99: Math.round(percentile(ms, 0.99)),
            max: Math.round(ms[ms.length - 1] ?? 0),
        };
    });
}

async function startSpike(world: World): Promise<void> {
    const started = performance.now();
    await Promise.all(
        world.sessions.map(async (session, i) => {
            await sleep(Math.floor((i / USERS) * START_S * 1000));
            const base = `/api/v1/exams/${world.exam}`;
            await call("POST", `${base}/join`, session);
            await call("POST", `${base}/consent`, session, { text_version: 1 });
            await call("POST", `${base}/start`, session);
        }),
    );
    out(`start spike: ${USERS} people in ${Math.round(performance.now() - started)} ms`);
}

// One person's working life: a draft that grows, saved with a rising number; the highest number the server
// acknowledged is what must be stored afterwards.
async function work(world: World, acked: Map<string, number>): Promise<void> {
    const until = performance.now() + WORK_S * 1000;
    await Promise.all(
        world.sessions.map(async (session, i) => {
            const email = world.emails[i] ?? "";
            const base = `/api/v1/exams/${world.exam}`;
            await sleep(Math.floor(Math.random() * SAVE_S * 1000));
            let content = "int main() {\n";
            for (let seq = 1; performance.now() < until; seq++) {
                content += `    // step ${seq} of ${email}\n`;
                const reply = await call("PUT", `${base}/problems/A/draft`, session, {
                    seq,
                    language: "cpp",
                    content,
                });
                if (reply.status === 200) acked.set(email, seq);
                if (seq % TELEMETRY_EVERY_SAVES === 0) {
                    await call("POST", `${base}/telemetry`, session, {
                        events: [{ kind: "focus_lost", t: Date.now(), data: {} }],
                    });
                }
                await sleep(SAVE_S * 1000);
            }
        }),
    );
}

async function handIn(world: World): Promise<void> {
    await Promise.all(
        world.sessions.map((s) => call("POST", `/api/v1/exams/${world.exam}/submit`, s)),
    );
}

async function lostSaves(database: TestDatabase, acked: Map<string, number>): Promise<number> {
    const rows = await database.database.sql<{ email: string; seq: number }[]>`
        select u.email::text as email, max(d.seq) as seq from exam_drafts d
        join exam_sessions s on s.id = d.session_id join users u on u.id = s.user_id group by u.email`;
    const stored = new Map(rows.map((r) => [r.email, r.seq]));
    let lost = 0;
    for (const [email, seq] of acked) if ((stored.get(email) ?? 0) < seq) lost++;
    return lost;
}

async function main(): Promise<number> {
    const database = await createMigratedTestDatabase(8);
    const children: ChildProcess[] = [];
    try {
        const world = await seed(database);
        out(`seeded: ${USERS} rostered people, 1 problem`);
        children.push(startService("http", database.url), startService("worker", database.url));
        await waitUntilListening();
        await startSpike(world);
        const acked = new Map<string, number>();
        await work(world, acked);
        await handIn(world);
        const { sql } = database.database;
        // The worker's tick queues at most 100 sittings a second; measure how long the whole class takes.
        const queueStart = performance.now();
        for (let waited = 0; waited < QUEUE_WAIT_S_MAX; waited++) {
            const [done] = await sql<{ n: string }[]>`select count(*)::text as n from exam_answers`;
            if (Number(done?.n) >= USERS) break;
            await sleep(1000);
        }
        out(
            `queued for the judge in ${Math.round(performance.now() - queueStart)} ms after the last hand-in`,
        );
        const lost = await lostSaves(database, acked);
        const [answers] = await sql<{ n: string }[]>`select count(*)::text as n from exam_answers`;
        const [jobs] = await sql<
            { n: string }[]
        >`select count(*)::text as n from jobs where queue = 'judge' and priority = 2`;
        out(`acknowledged: ${acked.size} people; people with a lost acknowledged save: ${lost}`);
        out(
            `handed in: answers ${answers?.n}, priority-2 judge jobs ${jobs?.n} (expected ${USERS})`,
        );
        const table = summary();
        for (const row of table) {
            out(
                `${row.kind.padEnd(48)} n=${row.count} err=${row.errors} (${row.statuses}) p50=${row.p50} p95=${row.p95} p99=${row.p99} max=${row.max} ms`,
            );
        }
        const report = {
            when: new Date().toISOString(),
            node: process.version,
            users: USERS,
            saveSeconds: SAVE_S,
            lost,
            answers: answers?.n,
            jobs: jobs?.n,
            table,
        };
        if (flags["report-file"] !== "")
            writeFileSync(String(flags["report-file"]), `${JSON.stringify(report, null, 2)}\n`);
        return lost === 0 && Number(answers?.n) === USERS && Number(jobs?.n) === USERS ? 0 : 1;
    } finally {
        agent.destroy();
        for (const child of children) child.kill("SIGTERM");
        await database.drop();
    }
}

process.exit(await main());
