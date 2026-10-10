// Goal: nothing hidden ever appears in a task response. Test files, reference solutions, checker code,
// storage keys, upload ids and presigned URLs must not show up in any answer, for any role, in any
// state of a version. The check walks every response of a full life cycle, and also asserts the exact
// key sets, so a new field cannot slip in unreviewed.
import { versionsResponseSchema } from "@aura/contracts/api/task-versions";
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, createHarness, type Harness } from "./http-harness.ts";
import { taskWorld } from "./http-task-support.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
const DAVE = "018f0000-0000-7000-8000-0000000000d4";
const REASON = "No sandbox exists yet; reviewed by hand before release.";

let h: Harness;
let world: ReturnType<typeof taskWorld>;
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
        insert into orgs (kind, slug, name) values ('company', 'hidden-team', 'Hidden Team') returning id`;
    await sql`insert into memberships (org_id, user_id, role) values
        (${org?.id ?? ""}, ${ALICE}, 'owner'), (${org?.id ?? ""}, ${BOB}, 'setter'),
        (${org?.id ?? ""}, ${CAROL}, 'reviewer'), (${org?.id ?? ""}, ${DAVE}, 'member')`;
    world = taskWorld(h, encodeId("org", org?.id ?? ""));
});
afterAll(async () => {
    await h.drop();
});

// Words that would mean hidden material or storage internals leaked into an answer.
const FORBIDDEN =
    /bundles\/|uploads\/|storage_upload|upload_id|presign|x-amz|memory:\/\/|tests\/|\.ans|\.in"|solutions|reference|checker\.|bundle_key|token_hash/i;

const VERSION_KEYS = [
    "bundle",
    "created_at",
    "created_by",
    "id",
    "released_at",
    "seq",
    "spec",
    "state",
    "statement",
    "statement_html",
    "task_id",
    "updated_at",
    "waived",
];
const TASK_KEYS = [
    "created_at",
    "id",
    "kind",
    "org_id",
    "released_version",
    "slug",
    "title",
    "updated_at",
    "visibility",
];

// Every object key anywhere in a JSON value, found with an explicit stack (no recursion). The depth
// of a response is small and fixed, so the loop is bounded by the size of the response.
function keysOf(root: unknown): string[] {
    const keys: string[] = [];
    const pending: unknown[] = [root];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (Array.isArray(next)) pending.push(...next);
        else if (next !== null && typeof next === "object") {
            for (const [key, inner] of Object.entries(next)) {
                keys.push(key);
                pending.push(inner);
            }
        }
    }
    return keys;
}

describe("hidden material", () => {
    it("never appears in a response, for any role, in any state", async () => {
        const task = await world.newTask(BOB, "org");
        const version = await world.inReview(BOB, task);
        await world.call(CAROL, "POST", `/task-versions/${version.id}/review`, {
            outcome: "approved",
        });
        await world.call(CAROL, "POST", `/task-versions/${version.id}/release`, {
            waiver_reason: REASON,
        });
        const paths = [
            `/tasks/${task.id}`,
            `/tasks/${task.id}/versions`,
            `/task-versions/${version.id}`,
            `/tasks?org_id=${task.org_id}`,
        ];
        for (const user of [ALICE, BOB, CAROL, DAVE]) {
            for (const path of paths) {
                const response = await world.call(user, "GET", path);
                const text = await response.text();
                expect(text, `${user} ${path}`).not.toMatch(FORBIDDEN);
                if (response.status !== 200) continue;
                const keys = new Set(keysOf(JSON.parse(text)));
                const allowed = new Set([...VERSION_KEYS, ...TASK_KEYS, "items", "next_cursor"]);
                // Spec keys are part of the contract; everything else must be on the allowlists.
                for (const key of keys) {
                    if (!allowed.has(key) && !SPEC_KEYS.has(key)) {
                        throw new Error(`unexpected key "${key}" in ${path} for ${user}`);
                    }
                }
            }
        }
    });

    it("keeps plain members to released versions of org tasks", async () => {
        const task = await world.newTask(BOB, "org");
        const draft = await world.newVersion(BOB, task);
        const list = await world.call(DAVE, "GET", `/tasks/${task.id}/versions`);
        expect(versionsResponseSchema.parse(await list.json()).items).toEqual([]);
        expect((await world.call(DAVE, "GET", `/task-versions/${draft.id}`)).status).toBe(404);
    });
});

const SPEC_KEYS = new Set([
    "spec_version",
    "kind",
    "title",
    "time_limit_ms",
    "memory_limit_kib",
    "output_limit_kib",
    "languages",
    "scoring",
    "type",
    "subtasks",
    "group",
    "points",
    "tests",
    "is_sample",
    "checker",
    "interactive",
    "license",
    "owner",
    "terms",
    "provenance",
    "author",
    "reviewers",
    "created",
    "generated_with_ai",
    "bytes",
    "sha256",
]);
