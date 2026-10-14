import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { parseArgs } from "node:util";
import { withRequestContext } from "@aura/db/context";
import { createMigratedTestDatabase, type TestDatabase } from "@aura/db/test-helpers";
import { out, PORT, sleep, startService, waitUntilListening } from "./dev-run-support.ts";
import {
    createPostgresScoreboardPort,
    refreshScoreboards,
} from "./modules/contests/scoreboard-tick.ts";
import { systemClock } from "./platform/clock.ts";

// Usage: node apps/api/src/contest-spike-cli.ts [--users=2000] [--spike-seconds=10] [--rate=100]
//        [--rate-seconds=60] [--problems=5] [--report-file=path]
// (needs: pnpm build, the local compose services.)
//
// The contest-start-spike of docs/kit/10 section 7, SCALED to one development machine: a real API and
// worker over real HTTP and a real PostgreSQL, a running contest with registered people, then
//   1. the spike: every person loads the contest, the scoreboard and a problem inside `spike-seconds`;
//   2. the stream of submissions at `rate` per second for `rate-seconds`, with a trickle of verdicts
//      landing so the scoreboard tick has changes to fold;
//   3. the check the kit asks for: no submission lost (accepted responses = rows = jobs).
// There is NO judge here, so verdict latency and judge throughput are not measured. The numbers describe
// this machine (the report records it) and are evidence of shape and of headroom, not a capacity claim.

const { values: flags } = parseArgs({
    options: {
        users: { type: "string", default: "2000" },
        "spike-seconds": { type: "string", default: "10" },
        rate: { type: "string", default: "100" },
        "rate-seconds": { type: "string", default: "60" },
        problems: { type: "string", default: "5" },
        "report-file": { type: "string", default: "" },
    },
});
const USERS = Number(flags["users"]);
const SPIKE_S = Number(flags["spike-seconds"]);
const RATE = Number(flags["rate"]);
const RATE_S = Number(flags["rate-seconds"]);
const PROBLEMS = Number(flags["problems"]);
const LABELS = Array.from({ length: PROBLEMS }, (_, i) => String.fromCharCode(65 + i));
const VERDICTS_PER_SECOND = 20; // judged results landing while the stream runs
const REQUEST_TIMEOUT_MS = 30_000;
const SEED_SOLVED_SHARE = 0.3; // share of people with accepted runs before the spike
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

function call(method: string, path: string, session: string, body?: unknown): Promise<number> {
    const started = performance.now();
    return new Promise<number>((resolve) => {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = request(
            {
                host: "127.0.0.1",
                port: PORT,
                path,
                method,
                agent,
                headers: {
                    cookie: `aura_session=${session}`,
                    "x-aura-request": "1",
                    origin: `http://localhost:${PORT}`,
                    "sec-fetch-site": "same-origin",
                    "accept-encoding": "gzip", // as a browser sends it
                    ...(payload
                        ? { "content-type": "application/json", "content-length": payload.length }
                        : {}),
                },
            },
            (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode ?? 0));
            },
        );
        req.on("error", () => resolve(0));
        // A request that never answers is an error to count, not a reason for the run to hang.
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy();
            resolve(0);
        });
        if (payload) req.write(payload);
        req.end();
    }).then((status) => {
        samples.push({
            kind: `${method} ${path.replace(/cst_[0-9a-f-]+/, ":contest")}`,
            status,
            ms: performance.now() - started,
        });
        return status;
    });
}

interface World {
    readonly contest: string; // public id
    readonly contestId: string;
    readonly sessions: readonly string[];
    readonly userIds: readonly string[];
}

async function seed(database: TestDatabase): Promise<World> {
    const { sql } = database.database;
    const [host] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'spike-uni', 'Spike University') returning id`;
    const hostId = host?.id ?? "";
    const [maker] = await sql<
        { id: string }[]
    >`insert into users (email, email_verified_at) values ('maker@spike.test', now()) returning id`;
    const [releaser] = await sql<
        { id: string }[]
    >`insert into users (email, email_verified_at) values ('releaser@spike.test', now()) returning id`;
    const makerId = maker?.id ?? "";
    const [contest] = await sql<
        { id: string }[]
    >`insert into contests (org_id, slug, title, format, rules, starts_at, ends_at, freeze_at, created_by)
        values (${hostId}, 'spike', 'Spike', 'icpc', ${sql.json({ format: "icpc", submit_interval_s: 10 })},
                now() - interval '5 minutes', now() + interval '3 hours', now() + interval '2 hours', ${makerId}) returning id`;
    const contestId = contest?.id ?? "";
    await sql.begin(async (tx) => {
        await tx`alter table task_versions disable trigger task_versions_guard`;
        for (const [index, label] of LABELS.entries()) {
            const [task] = await tx<
                { id: string }[]
            >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
                values (${hostId}, ${`spike-${index}`}, 'algorithmic', 'private', ${`P${label}`}, ${makerId}) returning id`;
            const [version] = await tx<{ id: string }[]>`insert into task_versions
                (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
                values (${hostId}, ${task?.id ?? ""}, 1, 'released', ${tx.json(SPEC)}, 'Add the numbers.', 10, ${randomBytes(32)}, ${makerId}, ${releaser?.id ?? ""}, now(), true, now()) returning id`;
            await tx`insert into contest_problems (contest_id, org_id, label, task_version_id, task_org_id)
                values (${contestId}, ${hostId}, ${label}, ${version?.id ?? ""}, ${hostId})`;
        }
        await tx`alter table task_versions enable trigger task_versions_guard`;
    });
    for (const state of ["scheduled", "running"]) {
        await sql`update contests set state = ${state} where id = ${contestId}`;
    }
    return people(database, contestId);
}

async function people(database: TestDatabase, contestId: string): Promise<World> {
    const { sql } = database.database;
    const users = Array.from({ length: USERS }, (_, i) => ({
        email: `u${i}@spike.test`,
        email_verified_at: new Date(),
    }));
    const ids: string[] = [];
    const sessions: string[] = [];
    const BATCH = 500;
    for (let from = 0; from < users.length; from += BATCH) {
        const rows = await sql<
            { id: string }[]
        >`insert into users ${sql(users.slice(from, from + BATCH), "email", "email_verified_at")} returning id`;
        const batch = rows.map((r) => r.id);
        const tokens = batch.map(() => randomBytes(32).toString("base64url"));
        await sql`insert into sessions ${sql(
            batch.map((userId, i) => ({
                user_id: userId,
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
        await sql`insert into registrations ${sql(batch.map((userId) => ({ contest_id: contestId, user_id: userId, created_at: new Date() })))}`;
        ids.push(...batch);
        sessions.push(...tokens);
    }
    return { contest: `cst_${contestId}`, contestId, sessions, userIds: ids };
}

// Some people have accepted runs already, so the board has content to fold from the first second.
async function seedJudged(database: TestDatabase, world: World): Promise<number> {
    const { sql } = database.database;
    const [versions] = await sql<
        { v: string[]; o: string }[]
    >`select array_agg(task_version_id order by label) as v, min(task_org_id::text) as o from contest_problems where contest_id = ${world.contestId}`;
    const solvers = world.userIds.slice(0, Math.floor(USERS * SEED_SOLVED_SHARE));
    let count = 0;
    for (const [index, userId] of solvers.entries()) {
        const solved = 1 + (index % Math.min(3, PROBLEMS));
        for (let p = 0; p < solved; p++) {
            const at = new Date(Date.now() - (4 * 60_000 - index));
            await sql.begin(async (tx) => {
                const [s] = await tx<
                    { id: string }[]
                >`insert into submissions (org_id, user_id, task_version_id, context_kind, context_id, language, source, source_sha256, source_bytes, created_at, updated_at)
                    values (${versions?.o ?? ""}, ${userId}, ${versions?.v[p] ?? ""}, 'contest', ${world.contestId}, 'cpp', 'x', ${randomBytes(32)}, 1, ${at}, ${at}) returning id`;
                await tx`update submissions set state = 'judging' where id = ${s?.id ?? ""}`;
                await tx`update submissions set state = 'judged', verdict = 'AC', judged_at = now() where id = ${s?.id ?? ""}`;
            });
            count++;
        }
    }
    return count;
}

function percentile(sorted: readonly number[], q: number): number {
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

function summary(): {
    kind: string;
    count: number;
    errors: number;
    statuses: string;
    p50: number;
    p95: number;
    p99: number;
    max: number;
}[] {
    const kinds = [...new Set(samples.map((s) => s.kind))].sort();
    return kinds.map((kind) => {
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

async function spike(world: World): Promise<void> {
    const started = performance.now();
    await Promise.all(
        world.sessions.map(async (session, i) => {
            await sleep(Math.floor((i / USERS) * SPIKE_S * 1000));
            await call("GET", `/api/v1/contests/${world.contest}`, session);
            await Promise.all([
                call("GET", `/api/v1/contests/${world.contest}/scoreboard`, session),
                call("GET", `/api/v1/contests/${world.contest}/problems/A`, session),
            ]);
        }),
    );
    out(
        `spike: ${USERS} people, ${samples.length} requests in ${Math.round(performance.now() - started)} ms`,
    );
}

// Submissions at a fixed rate, one person at a time in turn so nobody breaks the per-problem interval, and a
// trickle of verdicts so the board changes while it is read.
async function stream(database: TestDatabase, world: World): Promise<number> {
    const { sql } = database.database;
    const total = RATE * RATE_S;
    const accepted: Promise<number>[] = [];
    const startedAt = performance.now();
    for (let n = 0; n < total; n++) {
        const due = startedAt + (n / RATE) * 1000;
        const wait = due - performance.now();
        if (wait > 0) await sleep(wait);
        // Start with the people who have solved nothing yet, so a verdict landing changes the standings.
        const who = (Math.floor(USERS * SEED_SOLVED_SHARE) + n) % USERS;
        const label = LABELS[Math.floor(n / USERS) % PROBLEMS] ?? "A";
        accepted.push(
            call(
                "POST",
                `/api/v1/contests/${world.contest}/problems/${label}/submissions`,
                world.sessions[who] ?? "",
                {
                    language: "cpp",
                    source: "int main(){return 0;}",
                },
            ),
        );
        if (n % Math.floor(RATE / VERDICTS_PER_SECOND) === 0) void judgeOne(sql);
    }
    const statuses = await Promise.all(accepted);
    return statuses.filter((s) => s === 201).length;
}

async function judgeOne(sql: TestDatabase["database"]["sql"]): Promise<void> {
    await sql`update submissions set state = 'judging', updated_at = now() where id = (select id from submissions where state = 'queued' and context_kind = 'contest' order by id limit 1 for update skip locked)`.catch(
        () => undefined,
    );
    await sql`update submissions set state = 'judged', verdict = 'AC', judged_at = now(), updated_at = now() where id = (select id from submissions where state = 'judging' order by id limit 1 for update skip locked)`.catch(
        () => undefined,
    );
}

// What one scoreboard tick costs the database for this contest: the stamp check, then the input document.
async function timeTick(database: TestDatabase, world: World): Promise<void> {
    const { sql } = database.database;
    const worker = async <T>(work: () => Promise<T>) => {
        const started = performance.now();
        await work();
        return Math.round(performance.now() - started);
    };
    const stampMs = await worker(() => sql`select scoreboard_stamp(${world.contestId})`);
    const inputMs = await worker(
        () => sql`select length(scoreboard_input(${world.contestId})::text)`,
    );
    out(`one tick's queries: stamp ${stampMs} ms, input document ${inputMs} ms`);
    const context = {
        clock: systemClock,
        inTransaction: <T>(work: Parameters<typeof withRequestContext<T>>[2]) =>
            withRequestContext(
                sql,
                { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] },
                work,
            ),
    };
    const tickMs = await worker(() =>
        refreshScoreboards(createPostgresScoreboardPort(context), systemClock),
    );
    out(`one whole tick, in this process: ${tickMs} ms`);
}

async function boardVersions(database: TestDatabase, world: World): Promise<number> {
    const [row] = await database.database.sql<
        { version: number }[]
    >`select version from contest_scoreboards where contest_id = ${world.contestId} and view = 'public'`;
    return row?.version ?? 0;
}

async function main(): Promise<number> {
    const database = await createMigratedTestDatabase(8);
    const children: ChildProcess[] = [];
    try {
        const world = await seed(database);
        out(
            `seeded: ${USERS} registered people, ${PROBLEMS} problems, ${await seedJudged(database, world)} accepted runs`,
        );
        await timeTick(database, world);
        children.push(startService("http", database.url), startService("worker", database.url));
        await waitUntilListening();
        await sleep(3000); // the first board
        await spike(world);
        const versionBefore = await boardVersions(database, world);
        const accepted = await stream(database, world);
        await sleep(3000);
        const versionAfter = await boardVersions(database, world);
        const { sql } = database.database;
        const [rows] = await sql<
            { n: string }[]
        >`select count(*)::text as n from submissions where context_id = ${world.contestId} and created_at > now() - interval '1 hour' and source_bytes = 21`;
        const [jobs] = await sql<
            { n: string }[]
        >`select count(*)::text as n from jobs where queue = 'judge' and priority = 1`;
        const lost = accepted - Number(rows?.n ?? 0);
        out(
            `stream: ${accepted} accepted of ${RATE * RATE_S}; rows ${rows?.n}; priority-1 jobs ${jobs?.n}; lost ${lost}`,
        );
        const [judged] = await sql<
            { n: string }[]
        >`select count(*)::text as n from submissions where context_id = ${world.contestId} and state = 'judged'`;
        out(
            `scoreboard versions during the run: ${versionAfter - versionBefore} (board version ${versionAfter}; ${judged?.n} judged runs now)`,
        );
        const busy = await sql<
            { state: string; wait: string | null; seconds: number; query: string }[]
        >`select state, wait_event as wait, extract(epoch from now() - query_start)::float as seconds, left(query, 90) as query from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'`;
        for (const row of busy)
            out(
                `busy: ${row.state} wait=${row.wait} for ${Math.round(row.seconds)} s: ${row.query}`,
            );
        const table = summary();
        for (const row of table)
            out(
                `${row.kind.padEnd(58)} n=${row.count} err=${row.errors} (${row.statuses}) p50=${row.p50} p95=${row.p95} p99=${row.p99} max=${row.max} ms`,
            );
        const report = {
            when: new Date().toISOString(),
            node: process.version,
            users: USERS,
            rate: RATE,
            rateSeconds: RATE_S,
            accepted,
            lost,
            boardVersions: versionAfter - versionBefore,
            table,
        };
        if (flags["report-file"] !== "")
            writeFileSync(String(flags["report-file"]), `${JSON.stringify(report, null, 2)}\n`);
        return lost === 0 ? 0 : 1;
    } finally {
        agent.destroy();
        for (const child of children) child.kill("SIGTERM");
        await database.drop();
    }
}

process.exit(await main());
