// Goal: the judging loop end to end through the real HTTP app, PostgreSQL and in-memory storage. A
// participant submits; an active node leases the job with its fencing epoch; heartbeats keep the lease;
// a result is accepted only from the current holder, is checked against the spec and decides the
// verdict; impossible or system-error reports send the job to another node; an expired lease passes to
// another node and the first node's late answer is refused; nodes download only the bundle of the job
// they hold. Hidden checker output never reaches the participant.

import { submissionSchema } from "@aura/contracts/api/submissions";
import { versionSchema } from "@aura/contracts/api/task-versions";
import { encodeId } from "@aura/contracts/ids";
import {
    enrollmentCreatedSchema,
    enrollResponseSchema,
    leaseResponseSchema,
} from "@aura/contracts/judge-protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { newKey, signedRequest, type TestKey } from "./http-judge-support.ts";
import { taskWorld } from "./http-task-support.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
const DAVE = "018f0000-0000-7000-8000-0000000000d4";
const REASON = "No sandbox exists yet; reviewed by hand before release.";
const JUDGE = "/api/judge/v1";

let h: Harness;
let world: ReturnType<typeof taskWorld>;
beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`update users set platform_role = 'admin' where id = ${ALICE}`;
    for (const [id, name] of [
        [CAROL, "carol"],
        [DAVE, "dave"],
    ] as const) {
        await sql`insert into users (id, email, email_verified_at) values (${id}, ${`${name}@example.com`}, now())`;
    }
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'judge-team', 'Judge Team') returning id`;
    await sql`insert into memberships (org_id, user_id, role) values
        (${org?.id ?? ""}, ${ALICE}, 'owner'), (${org?.id ?? ""}, ${BOB}, 'setter'),
        (${org?.id ?? ""}, ${CAROL}, 'reviewer'), (${org?.id ?? ""}, ${DAVE}, 'member')`;
    world = taskWorld(h, encodeId("org", org?.id ?? ""));
});
afterAll(async () => {
    await h.drop();
});
// Each test starts with an empty queue, so a job one test left leased cannot expire into the next.
beforeEach(async () => {
    await h.db.database.sql`delete from jobs`;
    await h.db.database.sql`delete from submissions`;
});

interface Node {
    nodeId: string;
    key: TestKey;
}

async function activeNode(): Promise<Node> {
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
            name: `node-${Math.random().toString(36).slice(2, 8)}`,
            public_key: key.publicKey.toString("base64url"),
            agent_version: "0.1.0",
            tiers: [1],
        }),
    });
    const node = { nodeId: enrollResponseSchema.parse(await enrolled.json()).node_id, key };
    await call(node, "POST", "/node/heartbeat", {
        agent_version: "0.1.0",
        canary_ok: true,
        running_jobs: 0,
    });
    return node;
}

function call(node: Node, method: string, path: string, body?: unknown) {
    const signed = signedRequest(method, `${JUDGE}${path}`, body, {
        ...node,
        nowMs: h.clock.nowUnixMs(),
    });
    return h.app().request(`${JUDGE}${path}`, {
        method,
        headers: signed.headers,
        ...(method === "GET" ? {} : { body: signed.body }),
    });
}

async function releasedVersion(scoring?: "binary") {
    void scoring;
    const task = await world.newTask(BOB, "org");
    const version = await world.inReview(BOB, task);
    await world.call(CAROL, "POST", `/task-versions/${version.id}/review`, { outcome: "approved" });
    const released = await world.call(CAROL, "POST", `/task-versions/${version.id}/release`, {
        waiver_reason: REASON,
    });
    return versionSchema.parse(await released.json());
}

async function submitCode(versionId: string) {
    h.clock.advance(61_000);
    const response = await world.call(DAVE, "POST", `/task-versions/${versionId}/submissions`, {
        language: "cpp",
        source: "int main(){}",
    });
    expect(response.status).toBe(201);
    return submissionSchema.parse(await response.json());
}

async function lease(node: Node) {
    const response = await call(node, "POST", "/lease", { queue: "judge", wait_ms: 0 });
    expect(response.status).toBe(200);
    return leaseResponseSchema.parse(await response.json()).job;
}

function requireJob<T>(job: T | null): T {
    if (job === null) throw new Error("expected a job");
    return job;
}

const read = async (id: string) =>
    submissionSchema.parse(await (await world.call(DAVE, "GET", `/submissions/${id}`)).json());
const passing = (ids: string[]) =>
    ids.map((test_id) => ({ test_id, verdict: "AC", cpu_ms: 10, wall_ms: 12, memory_kib: 1000 }));
const finish = (node: Node, job: { job_id: string; lease_epoch: number }, result: unknown) =>
    call(node, "POST", `/jobs/${job.job_id}/complete`, { lease_epoch: job.lease_epoch, result });

describe("leasing", () => {
    it("answers 'nothing' when the queue is empty, and refuses a node that is not active", async () => {
        const node = await activeNode();
        expect(await lease(node)).toBeNull();
        const drained = await activeNode();
        await call(drained, "POST", "/node/heartbeat", {
            agent_version: "0.1.0",
            canary_ok: false,
            running_jobs: 0,
        });
        const refused = await call(drained, "POST", "/lease", { queue: "judge", wait_ms: 0 });
        expect(refused.status).toBe(409);
    });

    it("hands out a submission with its epoch and the task spec, and marks it as being judged", async () => {
        const node = await activeNode();
        const version = await releasedVersion();
        const made = await submitCode(version.id);
        let job = await lease(node);
        while (job !== null && job.submission.id !== made.id) job = await lease(node);
        expect(job).not.toBeNull();
        expect(job?.lease_epoch).toBe(1);
        expect(job?.submission.source).toBe("int main(){}");
        expect(job?.task.spec.tests.length).toBe(1);
        expect((await read(made.id)).state).toBe("judging");
    });

    it("waits for work when asked to, and returns it as soon as it appears", async () => {
        const node = await activeNode();
        const version = await releasedVersion();
        const waiting = call(node, "POST", "/lease", { queue: "judge", wait_ms: 3000 });
        await new Promise((resolve) => setTimeout(resolve, 400));
        const made = await submitCode(version.id);
        const job = leaseResponseSchema.parse(await (await waiting).json()).job;
        expect(job?.submission.id).toBe(made.id);
    });
});

async function leased() {
    const node = await activeNode();
    const version = await releasedVersion();
    const made = await submitCode(version.id);
    const job = await lease(node);
    if (job === null) throw new Error("expected a job");
    return { node, version, made, job };
}

describe("results", () => {
    it("accepts a correct result, sets the verdict from the spec, and hides checker output", async () => {
        const { node, made, job } = await leased();
        const tests = passing(["001"]).map((t) => ({
            ...t,
            checker_msg: "secret jury answer 42\u0007",
        }));
        const response = await finish(node, job, { compile_ok: true, tests });
        expect(response.status).toBe(200);
        const judged = await read(made.id);
        expect([judged.state, judged.verdict, judged.score]).toEqual(["judged", "AC", 100]);
        expect(judged.tests).toEqual([
            { test_id: "001", verdict: "AC", cpu_ms: 10, wall_ms: 12, memory_kib: 1000 },
        ]);
        expect(JSON.stringify(judged)).not.toContain("secret jury");
        const stored = await h.db.database
            .sql`select checker_msg from verdict_details where submission_id = ${made.id.slice(4)}`;
        expect(stored[0]?.["checker_msg"]).toBe("secret jury answer 42 ");
        const audit = await h.db.database
            .sql`select 1 from audit_log where action = 'submission.judged' and target = ${made.id}`;
        expect(audit.length).toBe(1);
    });

    it("takes the verdict from the first failing test, not from the node's claim", async () => {
        const { node, made, job } = await leased();
        await finish(node, job, {
            compile_ok: true,
            tests: [{ test_id: "001", verdict: "WA", cpu_ms: 1, wall_ms: 1, memory_kib: 1 }],
        });
        const judged = await read(made.id);
        expect([judged.verdict, judged.score]).toEqual(["WA", 0]);
    });

    it("makes a compile failure CE", async () => {
        const { node, made, job } = await leased();
        await finish(node, job, { compile_ok: false, compile_message: "error: x", tests: [] });
        expect((await read(made.id)).verdict).toBe("CE");
    });

    it("sends impossible reports and system errors to another node, never to the participant", async () => {
        const { node, made, job } = await leased();
        const bad = await finish(node, job, { compile_ok: true, tests: passing(["nope"]) });
        expect(bad.status).toBe(400);
        const after = await read(made.id);
        expect([after.state, after.verdict]).toEqual(["queued", null]);
        const other = await activeNode();
        h.clock.advance(6_000);
        const second = await lease(other);
        expect(second?.lease_epoch).toBe(2);
        const system = await finish(other, requireJob(second), {
            compile_ok: true,
            tests: [{ test_id: "001", verdict: "SE", cpu_ms: 0, wall_ms: 0, memory_kib: 0 }],
        });
        expect(system.status).toBe(400);
        expect((await read(made.id)).verdict).toBeNull();
    });
});

describe("results: who may answer", () => {
    it("refuses answers from a node that does not hold the lease, or holds an older one", async () => {
        const { node, made, job } = await leased();
        const stranger = await activeNode();
        expect(
            (await finish(stranger, job, { compile_ok: true, tests: passing(["001"]) })).status,
        ).toBe(409);
        expect(
            (
                await finish(
                    node,
                    { ...job, lease_epoch: 2 },
                    { compile_ok: true, tests: passing(["001"]) },
                )
            ).status,
        ).toBe(409);
        expect(
            (await call(stranger, "POST", `/jobs/${job.job_id}/heartbeat`, { lease_epoch: 1 }))
                .status,
        ).toBe(409);
        // The real holder still can; and only once.
        expect(
            (await finish(node, job, { compile_ok: true, tests: passing(["001"]) })).status,
        ).toBe(200);
        expect(
            (await finish(node, job, { compile_ok: true, tests: passing(["001"]) })).status,
        ).toBe(409);
        expect((await read(made.id)).verdict).toBe("AC");
    });

    it("rejects malformed results", async () => {
        const { node, job } = await leased();
        for (const bad of [
            {},
            { compile_ok: true },
            { compile_ok: true, tests: [{ test_id: "001", verdict: "AC" }] },
            { compile_ok: true, tests: [], extra: 1 },
        ]) {
            expect((await finish(node, job, bad)).status).toBe(400);
        }
    });
});

describe("heartbeats, failures and expiry", () => {
    it("keeps a lease alive with heartbeats, and lets it pass to another node when they stop", async () => {
        // Enrolling a node moves the fake clock on, so both nodes exist before the lease starts.
        const node = await activeNode();
        const other = await activeNode();
        const version = await releasedVersion();
        const made = await submitCode(version.id);
        const job = await lease(node);
        if (job === null) throw new Error("expected a job");
        h.clock.advance(25_000);
        expect(
            (
                await call(node, "POST", `/jobs/${job.job_id}/heartbeat`, {
                    lease_epoch: job.lease_epoch,
                })
            ).status,
        ).toBe(200);
        h.clock.advance(25_000);
        expect(await lease(other)).toBeNull();
        h.clock.advance(31_000);
        // The expired lease is noticed when someone asks for work; the job then waits out its backoff.
        expect(await lease(other)).toBeNull();
        h.clock.advance(6_000);
        const taken = await lease(other);
        expect(taken?.submission.id).toBe(made.id);
        expect(taken?.lease_epoch).toBe(2);
        // The first node comes back late: its answer changes nothing.
        expect(
            (await finish(node, job, { compile_ok: true, tests: passing(["001"]) })).status,
        ).toBe(409);
        expect(
            (await finish(other, requireJob(taken), { compile_ok: true, tests: passing(["001"]) }))
                .status,
        ).toBe(200);
        expect((await read(made.id)).verdict).toBe("AC");
    });

    it("retries a retryable failure and gives up on a permanent one", async () => {
        const node = await activeNode();
        const version = await releasedVersion();
        const retried = await submitCode(version.id);
        const first = await lease(node);
        if (first === null) throw new Error("expected a job");
        const failed = await call(node, "POST", `/jobs/${first.job_id}/fail`, {
            lease_epoch: first.lease_epoch,
            error: "disk full",
            retryable: true,
        });
        expect(failed.status).toBe(200);
        expect((await read(retried.id)).state).toBe("queued");
        h.clock.advance(6_000);
        const second = await lease(node);
        if (second === null) throw new Error("expected the job again");
        await call(node, "POST", `/jobs/${second.job_id}/fail`, {
            lease_epoch: second.lease_epoch,
            error: "bundle is corrupt",
            retryable: false,
        });
        const done = await read(retried.id);
        expect([done.state, done.verdict]).toEqual(["failed_system", null]);
    });
});

describe("bundle downloads", () => {
    it("go only to a node holding a lease for that task's bundle", async () => {
        const node = await activeNode();
        const version = await releasedVersion();
        await submitCode(version.id);
        const job = await lease(node);
        if (job === null) throw new Error("expected a job");
        const sha = job.task.bundle.sha256;
        const ok = await call(node, "GET", `/bundles/${sha}?job_id=${job.job_id}`);
        expect(ok.status).toBe(302);
        const location = ok.headers.get("location") ?? "";
        expect(h.storage.fetchDownload(location)?.length).toBe(job.task.bundle.bytes);
        const stranger = await activeNode();
        expect((await call(stranger, "GET", `/bundles/${sha}?job_id=${job.job_id}`)).status).toBe(
            404,
        );
        expect(
            (await call(node, "GET", `/bundles/${"0".repeat(64)}?job_id=${job.job_id}`)).status,
        ).toBe(404);
        expect((await call(node, "GET", `/bundles/${sha}`)).status).toBe(400);
    });
});
