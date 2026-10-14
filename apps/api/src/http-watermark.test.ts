// Goal: the node side of delivery watermarks end to end through the real HTTP app and PostgreSQL. A
// placed order queues a watermark job per version; a node leases it, downloads the bundle, gets a URL for
// the rewritten one, uploads it and reports; the control plane measures what arrived (never the node's
// word), accepts it only if every verdict is unchanged, records it with a tag the node never saw, and
// queues the manifest build when the last version is done.
import { createHash } from "node:crypto";
import { versionSchema } from "@aura/contracts/api/task-versions";
import { decodeId, encodeId } from "@aura/contracts/ids";
import {
    enrollmentCreatedSchema,
    enrollResponseSchema,
    leaseResponseSchema,
} from "@aura/contracts/judge-protocol";
import { VALIDATION_ATTACKERS, type ValidationResult } from "@aura/contracts/validation";
import {
    watermarkLeaseResponseSchema,
    watermarkUploadResponseSchema,
} from "@aura/contracts/watermark";
import { inRole } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { newKey, signedRequest, type TestKey } from "./http-judge-support.ts";
import { taskWorld } from "./http-task-support.ts";
import { deliveryBundleKey, uploadKey } from "./platform/object-storage.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
const JUDGE = "/api/judge/v1";
const NOW = new Date("2026-10-14T10:00:00Z");

let h: Harness;
let world: ReturnType<typeof taskWorld>;
let customer = "";
beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`update users set platform_role = 'admin' where id = ${ALICE}`;
    await sql`insert into users (id, email, email_verified_at) values (${CAROL}, 'carol@example.com', now())`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'wm-team', 'WM') returning id`;
    const [lab] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('ai_lab', 'wm-lab', 'Lab') returning id`;
    customer = lab?.id ?? "";
    await sql`insert into memberships (org_id, user_id, role) values
        (${org?.id ?? ""}, ${ALICE}, 'owner'), (${org?.id ?? ""}, ${BOB}, 'setter'), (${org?.id ?? ""}, ${CAROL}, 'reviewer')`;
    world = taskWorld(h, encodeId("org", org?.id ?? ""), { assigner: ALICE, assignees: [CAROL] });
});
afterAll(async () => {
    await h.drop();
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
            name: `wmnode-${Math.random().toString(36).slice(2, 8)}`,
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

// A released version, ordered and placed; returns the delivery's raw id and the version.
async function placed() {
    const task = await world.newTask(BOB, "org");
    const version = await world.inReview(BOB, task);
    await world.call(CAROL, "POST", `/task-versions/${version.id}/review`, { outcome: "approved" });
    const released = await world.call(CAROL, "POST", `/task-versions/${version.id}/release`, {
        waiver_reason: "Checked by hand; no sandbox.",
    });
    const released2 = versionSchema.parse(await released.json());
    const admin = { actorKind: "user", userId: ALICE, orgIds: [] } as const;
    const watermark = randomHex();
    const rows = await inRole(h.db.database, "aura_app", admin, async (tx) => {
        const [order] = await tx<
            { id: string }[]
        >`select create_order(${customer}, 'T', 'L', 30, ${NOW}) as id`;
        await tx`select add_order_item(${order?.id ?? ""}, ${decodeId("tsv", released2.id)}, ${NOW})`;
        return tx<
            { id: string }[]
        >`select place_order(${order?.id ?? ""}, ${watermark}, ${NOW}) as id`;
    });
    return { deliveryId: rows[0]?.id ?? "", versionId: decodeId("tsv", released2.id) };
}
const randomHex = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");

async function lease(node: Node) {
    const response = await call(node, "POST", "/lease", { queue: "watermark", wait_ms: 0 });
    expect(response.status).toBe(200);
    return watermarkLeaseResponseSchema.parse(await response.json()).job;
}

const result = (verdict: "AC" | "WA"): ValidationResult => ({
    bundle: { opens: true },
    runs: [
        {
            solution: "reference.cpp",
            repeat: 1,
            compile_ok: true,
            tests: [{ test_id: "001", verdict, cpu_ms: 3 }],
        },
    ],
    mutants: [],
    attackers: VALIDATION_ATTACKERS.map((name) => ({ name, passed: 0, total: 1 })),
});
const rewritten = (uploadId: string, wrong = false) => ({
    outcome: "rewritten" as const,
    upload_id: uploadId,
    answers: false,
    solutions: true,
    observations: { original: result("AC"), rewritten: result(wrong ? "WA" : "AC") },
});
const delivered = async (deliveryId: string) =>
    h.db.database.sql<
        {
            sha: string;
            bytes: string;
            tag: string;
            solutions_marked: boolean;
            verdicts_checked: boolean;
        }[]
    >`
        select encode(sha256, 'hex') as sha, bytes::text, tag::text, solutions_marked, verdicts_checked from delivery_bundles where delivery_id = ${deliveryId}`;

describe("leasing a watermark job", () => {
    it("hands the job out once, with the spec and a tag, and only on its own queue", async () => {
        const node = await activeNode();
        const order = await placed();
        const judge = await call(node, "POST", "/lease", { queue: "judge", wait_ms: 0 });
        expect(leaseResponseSchema.parse(await judge.json()).job).toBeNull();
        const job = await lease(node);
        expect(job?.kind).toBe("delivery.watermark");
        expect(job?.task.spec.tests.length).toBe(1);
        expect(job?.task.tag).toBeGreaterThanOrEqual(2 ** 31);
        expect(await lease(node)).toBeNull();
        const bundle = await call(
            node,
            "GET",
            `/bundles/${job?.task.bundle.sha256}?job_id=${job?.job_id}`,
        );
        expect(bundle.status).toBe(302);
        expect(
            (await call(node, "GET", `/bundles/${"0".repeat(64)}?job_id=${job?.job_id}`)).status,
        ).toBe(404);
        expect(order.deliveryId).not.toBe("");
    });
});

describe("reporting", () => {
    it("records an unchanged bundle as delivered as is and queues the manifest build", async () => {
        const node = await activeNode();
        const order = await placed();
        const job = await lease(node);
        const done = await call(node, "POST", `/jobs/${job?.job_id}/watermark`, {
            lease_epoch: job?.lease_epoch,
            result: { outcome: "unchanged" },
        });
        expect(done.status).toBe(200);
        const [row] = await delivered(order.deliveryId);
        expect(row?.sha).toBe(job?.task.bundle.sha256);
        const builds = await h.db.database
            .sql`select 1 from jobs where kind = 'delivery.build' and payload->>'delivery_id' = ${order.deliveryId}`;
        expect(builds.length).toBe(1);
    });
});

describe("reporting a rewrite", () => {
    it("measures the rewritten bundle itself, stores it under the delivery's key and records its own tag", async () => {
        const node = await activeNode();
        const order = await placed();
        const job = await lease(node);
        const bytes = new TextEncoder().encode("a rewritten bundle, in bytes");
        const upload = watermarkUploadResponseSchema.parse(
            await (
                await call(node, "POST", `/jobs/${job?.job_id}/watermark/upload`, {
                    lease_epoch: job?.lease_epoch,
                    bytes: bytes.length,
                })
            ).json(),
        );
        expect(h.storage.putPart(upload.url, bytes)).toBe(true);
        const done = await call(node, "POST", `/jobs/${job?.job_id}/watermark`, {
            lease_epoch: job?.lease_epoch,
            result: rewritten(upload.upload_id),
        });
        expect(done.status).toBe(200);
        const sha = createHash("sha256").update(bytes).digest("hex");
        const [row] = await delivered(order.deliveryId);
        expect(row).toMatchObject({
            sha,
            bytes: String(bytes.length),
            solutions_marked: true,
            verdicts_checked: true,
        });
        expect(Number(row?.tag)).toBe(job?.task.tag);
        const [d] = await h.db.database.sql<
            { customer_org_id: string }[]
        >`select customer_org_id from deliveries where id = ${order.deliveryId}`;
        expect(
            h.storage.read(deliveryBundleKey(d?.customer_org_id ?? "", order.deliveryId, sha)),
        ).toBeDefined();
        const jobUuid = decodeId("job", job?.job_id ?? "");
        expect(h.storage.read(uploadKey(d?.customer_org_id ?? "", jobUuid))).toBeUndefined();
    });

    it("refuses a rewrite whose verdicts differ, one that was not re-checked, and stores nothing", async () => {
        const node = await activeNode();
        const order = await placed();
        const job = await lease(node);
        const upload = watermarkUploadResponseSchema.parse(
            await (
                await call(node, "POST", `/jobs/${job?.job_id}/watermark/upload`, {
                    lease_epoch: job?.lease_epoch,
                    bytes: 4,
                })
            ).json(),
        );
        h.storage.putPart(upload.url, new Uint8Array([1, 2, 3, 4]));
        const differs = await call(node, "POST", `/jobs/${job?.job_id}/watermark`, {
            lease_epoch: job?.lease_epoch,
            result: rewritten(upload.upload_id, true),
        });
        expect(differs.status).toBe(400);
        expect(await delivered(order.deliveryId)).toHaveLength(0);
        h.clock.advance(60_000);
        const again = await lease(node);
        expect(again?.lease_epoch).toBe(2);
        const unchecked = await call(node, "POST", `/jobs/${again?.job_id}/watermark`, {
            lease_epoch: again?.lease_epoch,
            result: { ...rewritten(upload.upload_id), observations: null },
        });
        expect(unchecked.status).toBe(400);
        expect(await delivered(order.deliveryId)).toHaveLength(0);
    });
});

describe("refusals", () => {
    it("refuses a stale lease, an upload nobody holds a lease for, and unknown fields", async () => {
        const node = await activeNode();
        await placed();
        const job = await lease(node);
        const stale = await call(node, "POST", `/jobs/${job?.job_id}/watermark`, {
            lease_epoch: 99,
            result: { outcome: "unchanged" },
        });
        expect(stale.status).toBe(409);
        const noLease = await call(node, "POST", `/jobs/${job?.job_id}/watermark/upload`, {
            lease_epoch: 99,
            bytes: 4,
        });
        expect(noLease.status).toBe(409);
        const extra = await call(node, "POST", `/jobs/${job?.job_id}/watermark`, {
            lease_epoch: job?.lease_epoch,
            result: { outcome: "unchanged" },
            tag: 5,
        });
        expect(extra.status).toBe(400);
        const asJudge = await call(node, "POST", `/jobs/${job?.job_id}/complete`, {
            lease_epoch: job?.lease_epoch,
            result: { compile_ok: false, tests: [] },
        });
        expect(asJudge.status).toBe(409);
    });
});
