// Goal: environments and their runs through the real HTTP app and PostgreSQL. Authors create environments (a network
// allowlist is refused: no node can contain one); only a Tier-2 node can lease a run; the node's report is a trace signed
// by that node, checked before it is believed, and refused when unsigned, edited, inconsistent or from a lost lease; the
// result records its isolation, and a gVisor result is eligible only for what gVisor may support.

import { createHash } from "node:crypto";
import {
    environmentSchema,
    envRunSchema,
    leaderboardResponseSchema,
} from "@aura/contracts/api/environments";
import { decodeId } from "@aura/contracts/ids";
import {
    enrollmentCreatedSchema,
    enrollResponseSchema,
    envLeaseResponseSchema,
} from "@aura/contracts/judge-protocol";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { newKey, signedRequest, type TestKey } from "./http-judge-support.ts";
import { failDeadRuns } from "./modules/environments/tick.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3"; // a stranger to the organization
const JUDGE = "/api/judge/v1";
const HEX = "a".repeat(64);
let h: Harness;
let org = "";
let orgPublic = "";

const spec = (over: Record<string, unknown> = {}) => ({
    spec_version: 2,
    kind: "repo_env",
    title: "Fix the test",
    image: { digest: `sha256:${HEX}` },
    setup: [],
    agent: {
        command: ["python", "agent.py"],
        workspace: "/work",
        time_limit_s: 60,
        memory_limit_mib: 256,
        disk_limit_mib: 64,
        pids_limit: 64,
        output_limit_kib: 64,
    },
    network: { mode: "none" },
    verifier: { command: ["pytest"], time_limit_s: 60, memory_limit_mib: 256, canaries: 1 },
    integrity: { protected_paths: ["/work/tests"], honeypots: [] },
    scoring: { type: "binary" },
    ...over,
});
const body = (slug: string, over: Record<string, unknown> = {}) => ({
    slug,
    title: "Fix the test",
    spec: spec(over),
    image_key: "environments/image.tar",
    hidden_key: "environments/hidden.tar",
    hidden_sha256: HEX,
});

beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`update users set platform_role = 'admin' where id = ${ALICE}`;
    await sql`insert into users (id, email, email_verified_at) values (${CAROL}, 'carol@example.com', now())`;
    const [o] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'env-team', 'Env Team') returning id`;
    org = o?.id ?? "";
    orgPublic = `org_${org}`;
    await sql`insert into memberships (org_id, user_id, role) values (${org}, ${ALICE}, 'owner'), (${org}, ${BOB}, 'member')`;
});
afterAll(async () => {
    await h.drop();
});
// Each test starts with an empty queue, so a run an earlier test left cannot be leased by this one.
beforeEach(async () => {
    await h.db.database.sql`delete from jobs where queue = 'env'`;
    await h.db.database
        .sql`update env_runs set state = 'failed', outcome = 'sandbox_error', finished_at = now() where state = 'queued'`;
});

const call = async (user: string, method: string, path: string, payload?: unknown) =>
    h.request(path, {
        method,
        headers: browser(
            (await h.login(user)).token,
            payload === undefined ? {} : { "content-type": "application/json" },
        ),
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

interface Node {
    nodeId: string;
    key: TestKey;
}
async function node(tiers: number[]): Promise<Node> {
    h.clock.advance(61_000);
    const admin = await h.login(ALICE);
    const created = await h.request("/admin/judge-nodes/enrollments", {
        method: "POST",
        headers: browser(admin.token),
    });
    const { token } = enrollmentCreatedSchema.parse(await created.json());
    const key = newKey();
    const enrolled = await h.app().request(`${JUDGE}/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            token,
            name: `node-${tiers.join("")}-${Math.floor(h.clock.nowUnixMs() % 100000)}`,
            public_key: key.publicKey.toString("base64url"),
            agent_version: "0.1.0",
            tiers,
        }),
    });
    const made = { nodeId: enrollResponseSchema.parse(await enrolled.json()).node_id, key };
    await nodeCall(made, "POST", "/node/heartbeat", {
        agent_version: "0.1.0",
        canary_ok: true,
        running_jobs: 0,
    });
    return made;
}
function nodeCall(n: Node, method: string, path: string, payload?: unknown) {
    const signed = signedRequest(method, `${JUDGE}${path}`, payload, {
        ...n,
        nowMs: h.clock.nowUnixMs(),
    });
    return h.app().request(`${JUDGE}${path}`, {
        method,
        headers: signed.headers,
        ...(method === "GET" ? {} : { body: signed.body }),
    });
}

const trace = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
        version: 1,
        isolation: "gvisor",
        outcome: "completed",
        start_hash: HEX,
        steps: [
            {
                name: "agent",
                argv: ["python", "agent.py"],
                verdict: "OK",
                exit_code: 0,
                wall_ms: 40,
                peak_memory_mib: 20,
                pids_peak: 3,
                stdout_bytes: 0,
                stdout_sha256: HEX,
                tree_hash: HEX,
            },
        ],
        flags: [],
        verifier: { score: 1, detail: "match", dropped: [] },
        ...over,
    });
// What a node does: sign the SHA-256 of the exact trace text under the trace domain.
const signTrace = (key: TestKey, text: string) =>
    key
        .sign(`AURA-TRACE-V1\n${createHash("sha256").update(text).digest("hex")}`)
        .toString("base64url");

async function makeEnvironment(slug: string): Promise<string> {
    const made = await call(ALICE, "POST", `/orgs/${orgPublic}/environments`, body(slug));
    expect(made.status).toBe(201);
    return environmentSchema.parse(await made.json()).id;
}
async function leaseRun(n: Node) {
    const response = await nodeCall(n, "POST", "/lease", { queue: "env", wait_ms: 0 });
    expect(response.status).toBe(200);
    return envLeaseResponseSchema.parse(await response.json()).job;
}
async function request(env: string, extra: Record<string, unknown> = {}, label = "agent-1") {
    const response = await call(ALICE, "POST", `/environments/${env}/runs`, {
        agent_label: label,
        ...extra,
    });
    expect(response.status).toBe(202);
    return z.object({ run_id: z.string() }).parse(await response.json()).run_id;
}
const run = async (id: string) =>
    envRunSchema.parse(await (await call(ALICE, "GET", `/env-runs/${id}`)).json());

describe("authoring environments", () => {
    it("lets the organization's authors create one, refuses an allowlist and bad specs, and hides it from strangers", async () => {
        await makeEnvironment("fix-the-test");
        expect(
            (await call(ALICE, "POST", `/orgs/${orgPublic}/environments`, body("fix-the-test")))
                .status,
        ).toBe(409); // address taken
        expect(
            (await call(BOB, "POST", `/orgs/${orgPublic}/environments`, body("by-member"))).status,
        ).toBe(404); // a plain member does not author
        expect(
            (await call(CAROL, "POST", `/orgs/${orgPublic}/environments`, body("by-stranger")))
                .status,
        ).toBe(404);
        const allow = await call(
            ALICE,
            "POST",
            `/orgs/${orgPublic}/environments`,
            body("allowlisted", {
                network: { mode: "allowlist", allow: [{ host: "pypi.org", port: 443 }] },
            }),
        );
        expect(allow.status).toBe(400);
        expect(await allow.text()).toContain("network allowlists are not supported");
        expect(
            (
                await call(
                    ALICE,
                    "POST",
                    `/orgs/${orgPublic}/environments`,
                    body("bad", { image: { digest: "latest" } }),
                )
            ).status,
        ).toBe(400);
        const mine = await call(BOB, "GET", `/environments?org_id=${orgPublic}`);
        expect(
            z.object({ environments: z.array(z.unknown()) }).parse(await mine.json()).environments,
        ).toHaveLength(1); // members read
        const theirs = await call(CAROL, "GET", `/environments?org_id=${orgPublic}`);
        expect(
            z.object({ environments: z.array(z.unknown()) }).parse(await theirs.json())
                .environments,
        ).toEqual([]);
    });
});

describe("asking for a run and running it", () => {
    it("queues one run per agent, leases it only to a Tier-2 node, and records the signed result with its isolation", async () => {
        const env = await makeEnvironment("run-it");
        expect(
            (await call(BOB, "POST", `/environments/${env}/runs`, { agent_label: "x" })).status,
        ).toBe(404);
        expect(
            (await call(CAROL, "POST", `/environments/${env}/runs`, { agent_label: "x" })).status,
        ).toBe(404);
        // A customer webhook endpoint that wants this event: the finished run must be queued for it.
        await h.db.database
            .sql`insert into webhook_endpoints (org_id, url, events, secret_current, created_by, created_at)
            values (${org}, 'https://hooks.example.com/runs', array['env_run.finished'], ${"f".repeat(64)}, ${ALICE}, now())`;
        const id = await request(env);
        expect(
            (await call(ALICE, "POST", `/environments/${env}/runs`, { agent_label: "agent-1" }))
                .status,
        ).toBe(409); // already waiting
        expect((await run(id)).state).toBe("queued");

        const tier1 = await node([1]);
        expect(await leaseRun(tier1)).toBeNull(); // a node without Tier 2 is never given a run
        const tier2 = await node([1, 2]);
        const job = await leaseRun(tier2);
        expect(job).not.toBeNull();
        expect(job?.run_id).toBe(id);
        expect(job?.environment.spec["spec_version"]).toBe(2);
        expect(job?.environment.image_download_url).toBeTruthy();

        const text = trace({
            flags: [{ kind: "honeypot_touched", subject: ".hidden/a", explanation: "was read" }],
        });
        const done = await nodeCall(tier2, "POST", `/jobs/${job?.job_id}/env`, {
            lease_epoch: job?.lease_epoch,
            trace: text,
            trace_signature: signTrace(tier2.key, text),
        });
        expect(done.status).toBe(200);
        const finished = await run(id);
        expect(finished).toMatchObject({
            state: "done",
            isolation: "gvisor",
            outcome: "completed",
            score: 1,
            eligible: true,
        });
        expect(finished.flags).toEqual([
            { kind: "honeypot_touched", subject: ".hidden/a", explanation: "was read" },
        ]);
        expect(
            (
                await nodeCall(tier2, "POST", `/jobs/${job?.job_id}/env`, {
                    lease_epoch: job?.lease_epoch,
                    trace: text,
                    trace_signature: signTrace(tier2.key, text),
                })
            ).status,
        ).toBe(409); // a second report
        const [queued] = await h.db.database
            .sql`select payload from webhook_deliveries where source_id = ${decodeId("evr", id)}`;
        expect(queued?.["payload"]).toMatchObject({
            type: "env_run.finished",
            data: {
                run_id: id,
                state: "done",
                outcome: "completed",
                isolation: "gvisor",
                eligible: true,
            },
        });
        // The finished run is one billable event, keyed by the run.
        const [metered] = await h.db.database.sql<
            { n: number }[]
        >`select count(*)::int as n from usage_events where kind = 'env_run' and source_id = ${decodeId("evr", id)}`;
        expect(metered?.n).toBe(1);
    });
});

describe("the plan's monthly allowance of runs", () => {
    it("refuses the next run once the month's runs are used up, and counts only this month", async () => {
        const { sql } = h.db.database;
        // A fresh organization, so the other tests' finished runs do not count and the append-only events need no cleanup.
        const [fresh] = await sql<
            { id: string }[]
        >`insert into orgs (kind, slug, name) values ('company', 'limit-team', 'Limit Team') returning id`;
        const limitOrg = fresh?.id ?? "";
        await sql`insert into memberships (org_id, user_id, role) values (${limitOrg}, ${ALICE}, 'owner')`;
        const made = await call(ALICE, "POST", `/orgs/org_${limitOrg}/environments`, body("over"));
        const env = environmentSchema.parse(await made.json()).id;
        const now = new Date(h.clock.nowUnixMs());
        const lastMonth = new Date(h.clock.nowUnixMs() - 40 * 24 * 3600 * 1000);
        // The free plan allows 20 runs a month. Twenty old ones do not count; nineteen new ones leave room for exactly one.
        await sql`insert into usage_events (org_id, kind, source_id, occurred_at)
            select ${limitOrg}, 'env_run', gen_random_uuid(), ${lastMonth} from generate_series(1, 20)`;
        await sql`insert into usage_events (org_id, kind, source_id, occurred_at)
            select ${limitOrg}, 'env_run', gen_random_uuid(), ${now} from generate_series(1, 19)`;
        const last = await call(ALICE, "POST", `/environments/${env}/runs`, { agent_label: "a" });
        expect(last.status).toBe(202);
        const over = await call(ALICE, "POST", `/environments/${env}/runs`, { agent_label: "b" });
        expect(over.status).toBe(402);
        expect(await over.json()).toMatchObject({ code: "plan_limit_reached" });
        // A bigger plan lifts it.
        h.clock.advance(61_000);
        const admin = await call(ALICE, "PUT", `/admin/orgs/org_${limitOrg}/plan`, {
            plan: "team",
        });
        expect(admin.status).toBe(200);
        expect(
            (await call(ALICE, "POST", `/environments/${env}/runs`, { agent_label: "b" })).status,
        ).toBe(202);
    });
});

describe("what a run may be used for", () => {
    it("is eligible under gVisor only up to level 1, and for customer delivery only with the customer's opt-in", async () => {
        const env = await makeEnvironment("eligibility");
        const tier2 = await node([2]);
        const cases: [string, Record<string, unknown>, boolean][] = [
            ["level0", { assurance_level: 0 }, true],
            ["level1", { assurance_level: 1 }, true],
            ["level2", { assurance_level: 2 }, false],
            ["delivery", { customer_delivery: true }, false],
            [
                "delivered-ok",
                { customer_delivery: true, customer_opted_in: true, assurance_level: 1 },
                true,
            ],
            [
                "optin-level2",
                { customer_delivery: true, customer_opted_in: true, assurance_level: 2 },
                false,
            ],
        ];
        for (const [label, extra, eligible] of cases) {
            const id = await request(env, extra, label);
            const job = await leaseRun(tier2);
            const text = trace();
            await nodeCall(tier2, "POST", `/jobs/${job?.job_id}/env`, {
                lease_epoch: job?.lease_epoch,
                trace: text,
                trace_signature: signTrace(tier2.key, text),
            });
            expect((await run(id)).eligible, label).toBe(eligible);
        }
        expect(
            (
                await call(ALICE, "POST", `/environments/${env}/runs`, {
                    agent_label: "z",
                    customer_opted_in: true,
                })
            ).status,
        ).toBe(400); // opt-in is for delivery
    });
});

let counter = 0;
// A fresh waiting run, leased by `n`, and a way to send a report for it.
async function leased(env: string, n: Node) {
    const id = await request(env, {}, `agent-${++counter}`);
    const job = await leaseRun(n);
    expect(job?.run_id).toBe(id);
    const send = async (text: string, signature: string, epoch = job?.lease_epoch) =>
        nodeCall(n, "POST", `/jobs/${job?.job_id}/env`, {
            lease_epoch: epoch,
            trace: text,
            trace_signature: signature,
        });
    return { id, job, send };
}

describe("the private leaderboard", () => {
    it("ranks each agent's best eligible result, shows how often they tried and which runs were flagged, and is private", async () => {
        const env = await makeEnvironment("board");
        const tier2 = await node([2]);
        const finish = async (
            label: string,
            score: number,
            extra: Record<string, unknown> = {},
            flags: unknown[] = [],
        ) => {
            await request(env, extra, label);
            const job = await leaseRun(tier2);
            const text = trace({ verifier: { score, detail: "x", dropped: [] }, flags });
            await nodeCall(tier2, "POST", `/jobs/${job?.job_id}/env`, {
                lease_epoch: job?.lease_epoch,
                trace: text,
                trace_signature: signTrace(tier2.key, text),
            });
            h.clock.advance(1000);
        };
        await finish("alpha", 0.4);
        await finish("beta", 0.9, {}, [
            { kind: "honeypot_touched", subject: "h", explanation: "read" },
        ]);
        await finish("alpha", 0.7);
        await finish("gamma", 1, { assurance_level: 2 }); // best score, but not eligible at level 2 under gVisor
        await finish("delta", 0.7); // ties alpha's best, later
        const board = leaderboardResponseSchema.parse(
            await (await call(ALICE, "GET", `/environments/${env}/leaderboard`)).json(),
        ).rows;
        expect(board.map((r) => [r.rank, r.agent_label, r.best_score])).toEqual([
            [1, "beta", 0.9],
            [2, "alpha", 0.7],
            [3, "delta", 0.7],
        ]);
        expect(board[0]).toMatchObject({ runs: 1, flagged_runs: 1, isolation: "gvisor" });
        expect(board[1]).toMatchObject({ runs: 2, flagged_runs: 0 });
        expect((await call(BOB, "GET", `/environments/${env}/leaderboard`)).status).toBe(200); // a member reads
        expect((await call(CAROL, "GET", `/environments/${env}/leaderboard`)).status).toBe(404); // a stranger does not
    });
});

describe("refusing reports that cannot be trusted", () => {
    it("rejects an unsigned, edited, another node's or inconsistent trace, and the run stays unfinished", async () => {
        const env = await makeEnvironment("refusals");
        const a = await node([2]);
        const other = await node([2]);
        const good = trace();
        const cases: [
            string,
            (send: (t: string, s: string) => Promise<Response>) => Promise<Response>,
        ][] = [
            ["forged signature", (send) => send(good, signTrace(a.key, good).replace(/^./, "A"))],
            [
                "edited after signing",
                (send) => send(good.replace('"score":1', '"score":0.5'), signTrace(a.key, good)),
            ],
            ["another node's key", (send) => send(good, signTrace(other.key, good))],
            [
                "no verifier result",
                (send) =>
                    send(trace({ verifier: null }), signTrace(a.key, trace({ verifier: null }))),
            ],
            [
                "unknown isolation",
                (send) =>
                    send(
                        trace({ isolation: "chroot" }),
                        signTrace(a.key, trace({ isolation: "chroot" })),
                    ),
            ],
            [
                "extra field",
                (send) => send(trace({ extra: true }), signTrace(a.key, trace({ extra: true }))),
            ],
            [
                "score over 1",
                (send) =>
                    send(
                        trace({ verifier: { score: 2, detail: "", dropped: [] } }),
                        signTrace(
                            a.key,
                            trace({ verifier: { score: 2, detail: "", dropped: [] } }),
                        ),
                    ),
            ],
            [
                "no steps",
                (send) => send(trace({ steps: [] }), signTrace(a.key, trace({ steps: [] }))),
            ],
        ];
        for (const [name, attempt] of cases) {
            const { id, send } = await leased(env, a);
            expect((await attempt(send)).status, name).toBe(400);
            expect((await run(id)).state, name).toBe("queued");
        }
    });
});

describe("lease rules and dead runs", () => {
    it("refuses a report from the wrong epoch or from a node that does not hold the lease", async () => {
        const env = await makeEnvironment("lease");
        const a = await node([2]);
        const b = await node([2]);
        const { job, send } = await leased(env, a);
        const good = trace();
        expect((await send(good, signTrace(a.key, good), 999)).status).toBe(409);
        const stolen = await nodeCall(b, "POST", `/jobs/${job?.job_id}/env`, {
            lease_epoch: job?.lease_epoch,
            trace: good,
            trace_signature: signTrace(b.key, good),
        });
        expect(stolen.status).toBe(409);
        expect((await send(good, signTrace(a.key, good))).status).toBe(200);
    });

    it("fails a run whose job died, so nobody waits for it forever", async () => {
        const env = await makeEnvironment("dead");
        const id = await request(env);
        await h.db.database
            .sql`update jobs set state = 'dead' where dedupe_key = ${`env-run:${decodeId("evr", id)}`}`;
        expect(
            await failDeadRuns({
                clock: h.clock,
                inTransaction: (work) =>
                    withRequestContext(
                        h.db.database.sql,
                        { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] },
                        work,
                    ),
            }),
        ).toBe(1);
        expect(await run(id)).toMatchObject({
            state: "failed",
            outcome: "sandbox_error",
            eligible: false,
        });
    });
});
