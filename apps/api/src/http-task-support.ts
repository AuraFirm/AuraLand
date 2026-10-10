import { createHash, randomBytes } from "node:crypto";
import { uploadPlanSchema, versionSchema } from "@aura/contracts/api/task-versions";
import { taskSchema } from "@aura/contracts/api/tasks";
import { expect } from "vitest";
import { browser, type Harness } from "./http-harness.ts";

// Test support for the task routes: plays the browser against the real HTTP app and the in-memory
// storage, so each test can build a version in any state through the public API.

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export const SPEC = {
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

const JSON_HEADERS = { "content-type": "application/json" };

export function taskWorld(h: Harness, orgId: string) {
    let counter = 0;
    const call = async (user: string, method: string, path: string, body?: unknown) => {
        const { token } = await h.login(user);
        return h.request(path, {
            method,
            headers: browser(token, JSON_HEADERS),
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    };

    async function newTask(user: string, visibility = "private") {
        const response = await call(user, "POST", "/tasks", {
            org_id: orgId,
            slug: `world-${++counter}-${randomBytes(2).toString("hex")}`,
            title: "A task",
            kind: "algorithmic",
            visibility,
        });
        return taskSchema.parse(await response.json());
    }

    async function newVersion(user: string, task?: Awaited<ReturnType<typeof newTask>>) {
        const made = task ?? (await newTask(user));
        const response = await call(user, "POST", `/tasks/${made.id}/versions`, {});
        expect(response.status).toBe(201);
        return versionSchema.parse(await response.json());
    }

    // A draft with a bundle: finalized, so its state is "uploaded".
    async function uploadedVersion(user: string, task?: Awaited<ReturnType<typeof newTask>>) {
        const version = await newVersion(user, task);
        const bytes = new Uint8Array(randomBytes(200));
        const started = await call(user, "POST", `/task-versions/${version.id}/uploads`, {
            bytes: bytes.length,
            sha256: sha256(bytes),
        });
        const plan = uploadPlanSchema.parse(await started.json());
        expect(h.storage.putPart(plan.parts[0]?.url ?? "", bytes)).toBe(true);
        const done = await call(user, "POST", `/task-versions/${version.id}/finalize`, {
            upload_id: plan.upload_id,
        });
        expect(done.status).toBe(200);
        return version;
    }

    async function withContent(user: string, version: { id: string }) {
        const response = await call(user, "PATCH", `/task-versions/${version.id}`, {
            statement: "Add the numbers.",
            spec: SPEC,
        });
        expect(response.status).toBe(200);
    }

    // A version in review: uploaded, with content, submitted by `user`.
    async function inReview(user: string, task?: Awaited<ReturnType<typeof newTask>>) {
        const version = await uploadedVersion(user, task);
        await withContent(user, version);
        const submitted = await call(user, "POST", `/task-versions/${version.id}/submit-review`);
        expect(submitted.status).toBe(200);
        return version;
    }

    const stateOf = async (user: string, versionId: string) =>
        versionSchema.parse(await (await call(user, "GET", `/task-versions/${versionId}`)).json());

    return { call, newTask, newVersion, uploadedVersion, withContent, inReview, stateOf };
}
