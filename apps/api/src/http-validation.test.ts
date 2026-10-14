// Goal: task validation end to end through the real HTTP app and PostgreSQL. A reviewer asks for it;
// an active node leases the job, downloads the bundle and reports raw observations; the control plane
// derives the checks, stores an immutable report and moves the version; reports that cannot be true
// are refused and the job tried again; a dead job returns its version to its setter.
import { validationReportResponseSchema } from "@aura/contracts/api/validation";
import { decodeId, encodeId } from "@aura/contracts/ids";
import {
    enrollmentCreatedSchema,
    enrollResponseSchema,
    leaseResponseSchema,
    validationLeaseResponseSchema,
} from "@aura/contracts/judge-protocol";
import { VALIDATION_ATTACKERS, type ValidationResult } from "@aura/contracts/validation";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { newKey, signedRequest, type TestKey } from "./http-judge-support.ts";
import { taskWorld } from "./http-task-support.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
const DAVE = "018f0000-0000-7000-8000-0000000000d4";
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
    >`insert into orgs (kind, slug, name) values ('company', 'val-team', 'Val Team') returning id`;
    await sql`insert into memberships (org_id, user_id, role) values
        (${org?.id ?? ""}, ${ALICE}, 'owner'), (${org?.id ?? ""}, ${BOB}, 'setter'),
        (${org?.id ?? ""}, ${CAROL}, 'reviewer'), (${org?.id ?? ""}, ${DAVE}, 'member')`;
    world = taskWorld(h, encodeId("org", org?.id ?? ""), { assigner: ALICE, assignees: [CAROL] });
});
afterAll(async () => {
    await h.drop();
});
beforeEach(async () => {
    await h.db.database.sql`delete from jobs`;
});

interface Node {
    nodeId: string;
    key: TestKey;
}

async function activeNode(attestation?: "production"): Promise<Node> {
    h.clock.advance(61_000);
    const admin = await h.login(ALICE);
    const created = await h.request("/admin/judge-nodes/enrollments", {
        method: "POST",
        headers:
            attestation === undefined
                ? browser(admin.token)
                : { ...browser(admin.token), "content-type": "application/json" },
        ...(attestation === undefined ? {} : { body: JSON.stringify({ attestation }) }),
    });
    const { token } = enrollmentCreatedSchema.parse(await created.json());
    const key = newKey();
    const enrolled = await h.app().request(`${JUDGE}/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            token,
            name: `vnode-${Math.random().toString(36).slice(2, 8)}`,
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

async function requested() {
    const task = await world.newTask(BOB, "org");
    const version = await world.inReview(BOB, task);
    await world.call(CAROL, "POST", `/task-versions/${version.id}/review`, { outcome: "approved" });
    const response = await world.call(CAROL, "POST", `/task-versions/${version.id}/validate`);
    expect(response.status, h.logs.join("\n").slice(-1500)).toBe(200);
    return version;
}

async function leaseValidation(node: Node) {
    const response = await call(node, "POST", "/lease", { queue: "validate", wait_ms: 0 });
    expect(response.status, h.logs.join("\n").slice(-1500)).toBe(200);
    return validationLeaseResponseSchema.parse(await response.json()).job;
}

const run = (solution: string, verdict: "AC" | "WA", repeat = 1) => ({
    solution,
    repeat,
    compile_ok: true,
    tests: [{ test_id: "001", verdict, cpu_ms: 4 }],
});
const SOUND: ValidationResult = {
    bundle: { opens: true },
    mutants: [{ operator: "+ to -", line: 3, compile_ok: true, killed: true }],
    attackers: VALIDATION_ATTACKERS.map((name) => ({ name, passed: 0, total: 1 })),
    runs: [run("reference.cpp", "AC"), run("reference.cpp", "AC", 2), run("wrong_a.cpp", "WA")],
};
const WEAK: ValidationResult = {
    bundle: { opens: true },
    mutants: [{ operator: "+ to -", line: 3, compile_ok: true, killed: true }],
    attackers: VALIDATION_ATTACKERS.map((name) => ({ name, passed: 0, total: 1 })),
    runs: [run("reference.cpp", "AC"), run("reference.cpp", "AC", 2), run("wrong_a.cpp", "AC")],
};

const report = (node: Node, jobId: string, epoch: number, result: ValidationResult) =>
    call(node, "POST", `/jobs/${jobId}/validation`, { lease_epoch: epoch, result });
const stateOf = async (versionId: string) => (await world.stateOf(ALICE, versionId)).state;

describe("asking for validation", () => {
    it("is for owners, admins and reviewers of a version in review", async () => {
        const task = await world.newTask(BOB, "org");
        const version = await world.inReview(BOB, task);
        const ask = (user: string) =>
            world.call(user, "POST", `/task-versions/${version.id}/validate`);
        expect((await ask(BOB)).status).toBe(403); // the setter
        expect((await ask(DAVE)).status).toBe(404); // a plain member cannot even see a version in review
        expect((await ask(CAROL)).status).toBe(200);
        expect(await stateOf(version.id)).toBe("validating");
        expect((await ask(ALICE)).status).toBe(409); // already validating
        const [job] = await h.db.database
            .sql`select kind, queue from jobs where payload->>'task_version_id' is not null`;
        expect(job).toMatchObject({ kind: "task.validate", queue: "validate" });
    });
});

describe("the node side", () => {
    it("leases the job once, with the spec and bundle, and not through the judge queue", async () => {
        const node = await activeNode();
        const version = await requested();
        const judgeQueue = await call(node, "POST", "/lease", { queue: "judge", wait_ms: 0 });
        expect(leaseResponseSchema.parse(await judgeQueue.json()).job).toBeNull();
        const job = await leaseValidation(node);
        expect(job?.task.version_id).toBe(version.id);
        expect(job?.task.spec.tests.map((t) => t.id)).toEqual(["001"]);
        expect(await leaseValidation(node)).toBeNull();
        const bundle = await call(
            node,
            "GET",
            `/bundles/${job?.task.bundle.sha256}?job_id=${job?.job_id}`,
        );
        expect(bundle.status).toBe(302);
        const other = await call(node, "GET", `/bundles/${"0".repeat(64)}?job_id=${job?.job_id}`);
        expect(other.status).toBe(404);
    });

    it("turns a sound report into a validated version with an immutable report", async () => {
        const node = await activeNode("production");
        const version = await requested();
        const job = await leaseValidation(node);
        const accepted = await report(node, job?.job_id ?? "", job?.lease_epoch ?? 0, SOUND);
        expect(accepted.status).toBe(200);
        expect(await stateOf(version.id)).toBe("validated");
        const rows = await h.db.database
            .sql`select attestation, passed, jsonb_array_length(checks) as n
            from validation_reports`;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ attestation: "production", passed: true });
        const late = await report(node, job?.job_id ?? "", job?.lease_epoch ?? 0, SOUND);
        expect(late.status).toBe(409);
        const released = await world.call(
            CAROL,
            "POST",
            `/task-versions/${version.id}/release`,
            {},
        );
        expect(released.status).toBe(200);
    });
});

describe("the node side, reports", () => {
    it("sends a weak task back to its setter with the failing check on record", async () => {
        const node = await activeNode();
        const version = await requested();
        const job = await leaseValidation(node);
        expect((await report(node, job?.job_id ?? "", job?.lease_epoch ?? 0, WEAK)).status).toBe(
            200,
        );
        expect(await stateOf(version.id)).toBe("uploaded");
        const [row] = await h.db.database.sql<
            { passed: boolean; checks: unknown }[]
        >`select passed, checks from validation_reports where task_version_id = ${decodeId("tsv", version.id)}`;
        expect(row?.passed).toBe(false);
        expect(JSON.stringify(row?.checks)).toContain("passed every test");
    });
});

describe("reading the report", () => {
    it("shows staff the latest report with its evidence, and others nothing", async () => {
        const node = await activeNode("production");
        const version = await requested();
        const before = await world.call(CAROL, "GET", `/task-versions/${version.id}/validation`);
        expect(validationReportResponseSchema.parse(await before.json()).report).toBeNull();
        const job = await leaseValidation(node);
        await report(node, job?.job_id ?? "", job?.lease_epoch ?? 0, SOUND);
        const seen = validationReportResponseSchema.parse(
            await (
                await world.call(CAROL, "GET", `/task-versions/${version.id}/validation`)
            ).json(),
        );
        expect(seen.report).toMatchObject({ attestation: "production", passed: true, score: 90 });
        expect(seen.report?.checks.at(-1)?.name).toBe("score_at_least_70");
        expect(JSON.stringify(seen)).not.toMatch(/observations|node_id|cpu_ms/);
        const member = await world.call(DAVE, "GET", `/task-versions/${version.id}/validation`);
        expect(member.status).toBe(404); // a member cannot see a version in review at all
    });
});

describe("the score", () => {
    it("keeps a task whose tests catch no mutant out of validated, with its score on record", async () => {
        const node = await activeNode();
        const version = await requested();
        const job = await leaseValidation(node);
        const lax: ValidationResult = {
            ...SOUND,
            mutants: [{ operator: "+ to -", line: 3, compile_ok: true, killed: false }],
        };
        expect((await report(node, job?.job_id ?? "", job?.lease_epoch ?? 0, lax)).status).toBe(
            200,
        );
        expect(await stateOf(version.id)).toBe("uploaded");
        const [row] = await h.db.database.sql<
            { score: string; score_version: number; checks: unknown }[]
        >`
            select score, score_version, checks from validation_reports
            where task_version_id = ${decodeId("tsv", version.id)}`;
        expect(Number(row?.score)).toBe(50);
        expect(row?.score_version).toBe(1);
        expect(JSON.stringify(row?.checks)).toContain("score_at_least_70");
    });

    it("refuses a report that cannot be true and lets another node try", async () => {
        const first = await activeNode();
        const version = await requested();
        const job = await leaseValidation(first);
        const impossible: ValidationResult = {
            bundle: { opens: true },
            mutants: [],
            attackers: [],
            runs: [run("reference.cpp", "AC")].map((r) => ({ ...r, tests: [] })),
        };
        const refused = await report(first, job?.job_id ?? "", job?.lease_epoch ?? 0, impossible);
        expect(refused.status).toBe(400);
        expect(await stateOf(version.id)).toBe("validating");
        expect(
            await h.db.database
                .sql`select 1 from validation_reports where task_version_id = ${decodeId("tsv", version.id)}`,
        ).toHaveLength(0);
        h.clock.advance(60_000);
        const second = await activeNode();
        const again = await leaseValidation(second);
        expect(again?.lease_epoch).toBe(2);
    });

    it("lets the judge routes ignore validation jobs and unknown fields be refused", async () => {
        const node = await activeNode();
        await requested();
        const job = await leaseValidation(node);
        const asJudge = await call(node, "POST", `/jobs/${job?.job_id}/complete`, {
            lease_epoch: job?.lease_epoch,
            result: { compile_ok: false, tests: [] },
        });
        expect(asJudge.status).toBe(409);
        const extra = await call(node, "POST", `/jobs/${job?.job_id}/validation`, {
            lease_epoch: job?.lease_epoch,
            result: SOUND,
            verdict: "validated",
        });
        expect(extra.status).toBe(400);
    });
});

describe("a validation that never finishes", () => {
    it("returns the version to its setter once no live job names it", async () => {
        const version = await requested();
        const sql = h.db.database.sql;
        // Earlier tests left validating versions whose jobs were deleted; they are orphans too.
        await sql`select abort_orphaned_validations(now())`;
        const live = await requested();
        await sql`select abort_orphaned_validations(now())`;
        expect(await stateOf(live.id)).toBe("validating"); // its job is alive
        await sql`update jobs set state = 'dead' where queue = 'validate'`;
        await sql`select abort_orphaned_validations(now())`;
        expect(await stateOf(live.id)).toBe("uploaded");
        expect(await stateOf(version.id)).toBe("uploaded");
        expect(
            await sql`select 1 from validation_reports where task_version_id = ${decodeId("tsv", live.id)}`,
        ).toHaveLength(0);
    });
});
