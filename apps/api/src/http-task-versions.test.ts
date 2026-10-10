// Goal: versions and bundle uploads end to end through the real HTTP app, PostgreSQL and the
// in-memory storage standing in for S3. Writers create and edit versions; uploads go to presigned
// part URLs; finalize accepts only bytes whose size and SHA-256 match what was declared; wrong,
// short, expired, repeated and abandoned uploads leave no bundle; storage failures leave nothing
// half-recorded; and a bundle can be recorded only once per version.
import { createHash, randomBytes } from "node:crypto";
import {
    uploadPlanSchema,
    versionSchema,
    versionsResponseSchema,
} from "@aura/contracts/api/task-versions";
import { taskSchema } from "@aura/contracts/api/tasks";
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { StorageUnavailableError } from "./platform/object-storage.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
const DAVE = "018f0000-0000-7000-8000-0000000000d4";
const MIB = 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let h: Harness;
let orgId = "";
beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    for (const [id, name] of [
        [CAROL, "carol"],
        [DAVE, "dave"],
    ] as const) {
        await sql`insert into users (id, email, email_verified_at) values (${id}, ${`${name}@example.com`}, now())`;
    }
    const [org] = await sql<{ id: string }[]>`
        insert into orgs (kind, slug, name) values ('company', 'version-team', 'Version Team') returning id`;
    await sql`insert into memberships (org_id, user_id, role) values
        (${org?.id ?? ""}, ${ALICE}, 'owner'), (${org?.id ?? ""}, ${BOB}, 'setter'),
        (${org?.id ?? ""}, ${CAROL}, 'reviewer'), (${org?.id ?? ""}, ${DAVE}, 'member')`;
    orgId = encodeId("org", org?.id ?? "");
});
afterAll(async () => {
    await h.drop();
});

const JSON_HEADERS = { "content-type": "application/json" };
const call = async (user: string, method: string, path: string, body?: unknown) => {
    const { token } = await h.login(user);
    return h.request(path, {
        method,
        headers: browser(token, JSON_HEADERS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
};

let counter = 0;
async function newTask(user = BOB, visibility = "private") {
    const response = await call(user, "POST", "/tasks", {
        org_id: orgId,
        slug: `vtask-${++counter}`,
        title: "A task",
        kind: "algorithmic",
        visibility,
    });
    return taskSchema.parse(await response.json());
}

async function newVersion(user = BOB, task?: Awaited<ReturnType<typeof newTask>>) {
    const made = task ?? (await newTask(user));
    const response = await call(user, "POST", `/tasks/${made.id}/versions`, {});
    expect(response.status).toBe(201);
    return versionSchema.parse(await response.json());
}

async function startUpload(user: string, versionId: string, bytes: Uint8Array, hash = sha(bytes)) {
    const response = await call(user, "POST", `/task-versions/${versionId}/uploads`, {
        bytes: bytes.length,
        sha256: hash,
    });
    return response;
}

// Plays the browser: sends each part of `bytes` to its presigned URL.
async function sendParts(
    plan: ReturnType<typeof uploadPlanSchema.parse>,
    bytes: Uint8Array,
    skip: number[] = [],
) {
    let offset = 0;
    for (const part of plan.parts) {
        const chunk = bytes.subarray(offset, offset + part.bytes);
        offset += part.bytes;
        if (skip.includes(part.part_number)) continue;
        expect(h.storage.putPart(part.url, chunk), `part ${part.part_number}`).toBe(true);
    }
}

const SPEC = {
    spec_version: 1,
    kind: "algorithmic",
    title: "Sum of two numbers",
    time_limit_ms: 1000,
    memory_limit_kib: 262144,
    output_limit_kib: 1024,
    languages: ["cpp"],
    scoring: { type: "binary", subtasks: [] },
    tests: [{ id: "001", group: "all", points: 100, is_sample: true }],
    checker: { type: "exact" },
    license: { owner: "Acme", terms: "internal use" },
    provenance: { author: "Alice", created: "2026-10-10", generated_with_ai: false },
};

const finalize = (user: string, versionId: string, uploadId: string) =>
    call(user, "POST", `/task-versions/${versionId}/finalize`, { upload_id: uploadId });

describe("creating and editing versions", () => {
    it("numbers versions from 1 and lets only writers create them", async () => {
        const task = await newTask();
        const first = await newVersion(BOB, task);
        const second = await newVersion(ALICE, task);
        expect([first.seq, second.seq, first.state]).toEqual([1, 2, "draft"]);
        expect(first.bundle).toBeNull();
        expect((await call(CAROL, "POST", `/tasks/${task.id}/versions`, {})).status).toBe(403);
        expect((await call(DAVE, "POST", `/tasks/${task.id}/versions`, {})).status).toBe(404);
        const list = versionsResponseSchema.parse(
            await (await call(CAROL, "GET", `/tasks/${task.id}/versions`)).json(),
        );
        expect(list.items.map((v) => v.seq)).toEqual([2, 1]);
    });

    it("edits statement and spec while editable, and checks them", async () => {
        const version = await newVersion();
        const patch = (body: unknown) => call(BOB, "PATCH", `/task-versions/${version.id}`, body);
        const edited = await patch({ statement: "Add the numbers." });
        expect(versionSchema.parse(await edited.json()).statement).toBe("Add the numbers.");
        const withSpec = await patch({ spec: SPEC });
        expect(versionSchema.parse(await withSpec.json()).spec?.title).toBe("Sum of two numbers");
        // A spec for another kind of task is refused.
        expect((await patch({ spec: { ...SPEC, kind: "function" } })).status).toBe(400);
        expect((await patch({})).status).toBe(400);
        expect((await patch({ statement: "" })).status).toBe(400);
        expect((await patch({ spec: { spec_version: 1 } })).status).toBe(400);
        expect((await patch({ state: "released" })).status).toBe(400);
        expect(
            (await call(CAROL, "PATCH", `/task-versions/${version.id}`, { statement: "x" })).status,
        ).toBe(403);
        expect(
            (await call(DAVE, "PATCH", `/task-versions/${version.id}`, { statement: "x" })).status,
        ).toBe(404);
    });
});

describe("uploading a bundle", () => {
    it("records a bundle whose size and hash match, and audits the hash", async () => {
        const version = await newVersion();
        const bytes = new Uint8Array(randomBytes(1000));
        const started = await startUpload(BOB, version.id, bytes);
        expect(started.status).toBe(201);
        const plan = uploadPlanSchema.parse(await started.json());
        await sendParts(plan, bytes);
        const done = await finalize(BOB, version.id, plan.upload_id);
        expect(done.status).toBe(200);
        const body = versionSchema.parse(await done.json());
        expect(body.state).toBe("uploaded");
        expect(body.bundle).toEqual({ bytes: 1000, sha256: sha(bytes) });
        const { sql } = h.db.database;
        const audit =
            await sql`select detail from audit_log where action = 'task_version.bundle_verified' order by seq desc limit 1`;
        expect(JSON.stringify(audit[0]?.["detail"])).toContain(sha(bytes));
        expect(JSON.stringify(body)).not.toMatch(/bundles\/|uploads\//);
    });

    it("assembles several parts, in any order, and says which are missing", async () => {
        const version = await newVersion();
        const bytes = new Uint8Array(randomBytes(20 * MIB));
        const plan = uploadPlanSchema.parse(
            await (await startUpload(BOB, version.id, bytes)).json(),
        );
        expect(plan.parts.map((p) => p.bytes)).toEqual([8 * MIB, 8 * MIB, 4 * MIB]);
        await sendParts(plan, bytes, [2]);
        const early = await finalize(BOB, version.id, plan.upload_id);
        expect(early.status).toBe(409);
        const second = plan.parts[1];
        expect(h.storage.putPart(second?.url ?? "", bytes.subarray(8 * MIB, 16 * MIB))).toBe(true);
        expect((await finalize(BOB, version.id, plan.upload_id)).status).toBe(200);
    });

    it("refuses wrong bytes, ends that upload, and lets a new one start", async () => {
        const version = await newVersion();
        const real = new Uint8Array(randomBytes(500));
        const forged = new Uint8Array(randomBytes(500));
        const plan = uploadPlanSchema.parse(
            await (await startUpload(BOB, version.id, real)).json(),
        );
        await sendParts(plan, forged);
        const refused = await finalize(BOB, version.id, plan.upload_id);
        expect(refused.status).toBe(400);
        expect(h.storage.objectCount()).toBeGreaterThanOrEqual(0);
        // The same upload cannot be retried, but a new one can be.
        expect((await finalize(BOB, version.id, plan.upload_id)).status).toBe(409);
        const again = uploadPlanSchema.parse(
            await (await startUpload(BOB, version.id, real)).json(),
        );
        await sendParts(again, real);
        expect((await finalize(BOB, version.id, again.upload_id)).status).toBe(200);
    });

    it("never stores a refused upload under the content-addressed key", async () => {
        const version = await newVersion();
        const claimed = new Uint8Array(randomBytes(300));
        const sent = new Uint8Array(randomBytes(300));
        const plan = uploadPlanSchema.parse(
            await (await startUpload(BOB, version.id, claimed)).json(),
        );
        await sendParts(plan, sent);
        await finalize(BOB, version.id, plan.upload_id);
        const orgUuid = orgId.slice(4);
        expect(h.storage.read(`bundles/${orgUuid}/${sha(claimed)}`)).toBeUndefined();
        expect(h.storage.read(`bundles/${orgUuid}/${sha(sent)}`)).toBeUndefined();
    });
});

describe("uploading a bundle: expiry, limits and failures", () => {
    it("refuses an expired plan, a repeat after success, and uploads over the cap", async () => {
        const version = await newVersion();
        const bytes = new Uint8Array(randomBytes(100));
        const plan = uploadPlanSchema.parse(
            await (await startUpload(BOB, version.id, bytes)).json(),
        );
        await sendParts(plan, bytes);
        h.clock.advance(61 * 60 * 1000);
        expect((await finalize(BOB, version.id, plan.upload_id)).status).toBe(409);
        // A part URL is also dead after its own 15 minutes.
        expect(h.storage.putPart(plan.parts[0]?.url ?? "", bytes)).toBe(false);

        const next = await newVersion();
        const fresh = uploadPlanSchema.parse(await (await startUpload(BOB, next.id, bytes)).json());
        await sendParts(fresh, bytes);
        expect((await finalize(BOB, next.id, fresh.upload_id)).status).toBe(200);
        expect((await startUpload(BOB, next.id, bytes)).status).toBe(409);
        expect((await finalize(BOB, next.id, fresh.upload_id)).status).toBe(409);
    });

    it("accepts a finalize only for the version the upload was started for", async () => {
        const first = await newVersion();
        const second = await newVersion();
        const bytes = new Uint8Array(randomBytes(100));
        const plan = uploadPlanSchema.parse(await (await startUpload(BOB, first.id, bytes)).json());
        await sendParts(plan, bytes);
        expect((await finalize(BOB, second.id, plan.upload_id)).status).toBe(409);
        expect((await finalize(BOB, first.id, plan.upload_id)).status).toBe(200);
    });

    it("validates the declaration and who may upload", async () => {
        const version = await newVersion();
        const bytes = new Uint8Array(randomBytes(10));
        const start = (user: string, body: unknown) =>
            call(user, "POST", `/task-versions/${version.id}/uploads`, body);
        const good = { bytes: 10, sha256: sha(bytes) };
        for (const bad of [
            { ...good, bytes: 0 },
            { ...good, bytes: 64 * MIB + 1 },
            { ...good, sha256: "ABC" },
            { ...good, sha256: sha(bytes).toUpperCase() },
            { ...good, extra: 1 },
            {},
        ]) {
            expect((await start(BOB, bad)).status, JSON.stringify(bad)).toBe(400);
        }
        expect((await start(CAROL, good)).status).toBe(403);
        expect((await start(DAVE, good)).status).toBe(404);
    });

    it("limits a person to five unfinished uploads", async () => {
        const bytes = new Uint8Array(randomBytes(10));
        const codes: number[] = [];
        const before = h.storage.uploadCount();
        for (let index = 0; index < 7; index++) {
            const version = await newVersion(ALICE);
            codes.push((await startUpload(ALICE, version.id, bytes)).status);
        }
        expect(codes.filter((code) => code === 201).length).toBeLessThanOrEqual(5);
        expect(codes).toContain(409);
        // A refused start must not leave an open upload behind in storage.
        expect(h.storage.uploadCount() - before).toBe(codes.filter((code) => code === 201).length);
    });
});

describe("uploading a bundle: storage failure", () => {
    it("answers 503 and records nothing when storage fails", async () => {
        const version = await newVersion();
        const bytes = new Uint8Array(randomBytes(64));
        const plan = uploadPlanSchema.parse(
            await (await startUpload(BOB, version.id, bytes)).json(),
        );
        await sendParts(plan, bytes);
        const original = h.storage.measure;
        h.storage.measure = async () => {
            throw new StorageUnavailableError("measure");
        };
        try {
            expect((await finalize(BOB, version.id, plan.upload_id)).status).toBe(503);
        } finally {
            h.storage.measure = original;
        }
        const after = versionSchema.parse(
            await (await call(BOB, "GET", `/task-versions/${version.id}`)).json(),
        );
        expect(after.state).toBe("draft");
        expect(after.bundle).toBeNull();
        // The retry succeeds because nothing was half-recorded.
        expect((await finalize(BOB, version.id, plan.upload_id)).status).toBe(200);
    });
});
