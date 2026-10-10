// Goal: tasks end to end through the real HTTP app and PostgreSQL. Setters and above create and edit
// tasks in their own organization; reviewers and plain members cannot write; private tasks are
// invisible to plain members (404, never 403) while "org" tasks are readable; people outside the
// organization learn nothing; slugs are unique per organization; lists page without gaps or repeats;
// every change leaves an audit entry; and unsupported kinds and unknown fields are refused.
import { taskSchema, tasksResponseSchema } from "@aura/contracts/api/tasks";
import { encodeId } from "@aura/contracts/ids";
import { verifyAuditChain } from "@aura/db/audit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
const DAVE = "018f0000-0000-7000-8000-0000000000d4";
const ERIN = "018f0000-0000-7000-8000-0000000000e5";

let h: Harness;
let orgId = "";
let otherOrgId = "";
beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    for (const [id, name] of [
        [CAROL, "carol"],
        [DAVE, "dave"],
        [ERIN, "erin"],
    ] as const) {
        await sql`insert into users (id, email, email_verified_at) values (${id}, ${`${name}@example.com`}, now())`;
    }
    const [org] = await sql<{ id: string }[]>`
        insert into orgs (kind, slug, name) values ('company', 'task-team', 'Task Team') returning id`;
    const [other] = await sql<{ id: string }[]>`
        insert into orgs (kind, slug, name) values ('company', 'other-team', 'Other Team') returning id`;
    // ALICE owns, BOB sets, CAROL reviews, DAVE is a plain member; ERIN belongs elsewhere only.
    await sql`insert into memberships (org_id, user_id, role) values
        (${org?.id ?? ""}, ${ALICE}, 'owner'), (${org?.id ?? ""}, ${BOB}, 'setter'),
        (${org?.id ?? ""}, ${CAROL}, 'reviewer'), (${org?.id ?? ""}, ${DAVE}, 'member'),
        (${other?.id ?? ""}, ${ERIN}, 'owner')`;
    orgId = encodeId("org", org?.id ?? "");
    otherOrgId = encodeId("org", other?.id ?? "");
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
const create = (user: string, change: Record<string, unknown> = {}) =>
    call(user, "POST", "/tasks", {
        org_id: orgId,
        slug: `task-${++counter}`,
        title: "Sum of two numbers",
        kind: "algorithmic",
        ...change,
    });

describe("creating tasks", () => {
    it("lets owners and setters create, and audits it", async () => {
        for (const user of [ALICE, BOB]) {
            const response = await create(user);
            expect(response.status).toBe(201);
            const task = taskSchema.parse(await response.json());
            expect(task.visibility).toBe("private");
            expect(task.released_version).toBeNull();
        }
        const { sql } = h.db.database;
        const rows = await sql`select action from audit_log where action = 'task.created'`;
        expect(rows.length).toBeGreaterThanOrEqual(2);
        expect((await verifyAuditChain(sql)).ok).toBe(true);
    });

    it("refuses reviewers, plain members and outsiders", async () => {
        expect((await create(CAROL)).status).toBe(403);
        expect((await create(DAVE)).status).toBe(403);
        // An outsider is told the organization does not exist.
        expect((await create(ERIN)).status).toBe(404);
        expect((await create(BOB, { org_id: otherOrgId })).status).toBe(404);
    });

    it("refuses unsupported kinds, unknown fields and bad slugs", async () => {
        for (const change of [
            { kind: "sql" },
            { kind: "nothing" },
            { extra: 1 },
            { slug: "Bad Slug" },
            { slug: "ab" },
            { title: "" },
            { visibility: "public" },
        ]) {
            expect((await create(BOB, change)).status, JSON.stringify(change)).toBe(400);
        }
    });

    it("keeps slugs unique within an organization", async () => {
        expect((await create(BOB, { slug: "same-slug" })).status).toBe(201);
        expect((await create(ALICE, { slug: "same-slug" })).status).toBe(409);
    });
});

describe("who can read a task", () => {
    it("hides private tasks from plain members and shows org tasks to them", async () => {
        const hidden = taskSchema.parse(
            await (await create(BOB, { visibility: "private" })).json(),
        );
        const shown = taskSchema.parse(await (await create(BOB, { visibility: "org" })).json());
        expect((await call(DAVE, "GET", `/tasks/${hidden.id}`)).status).toBe(404);
        expect((await call(DAVE, "GET", `/tasks/${shown.id}`)).status).toBe(200);
        expect((await call(CAROL, "GET", `/tasks/${hidden.id}`)).status).toBe(200);
        expect((await call(ERIN, "GET", `/tasks/${hidden.id}`)).status).toBe(404);
        expect((await call(ERIN, "GET", `/tasks/${shown.id}`)).status).toBe(404);
    });

    it("lists newest first and pages without gaps or repeats", async () => {
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 20; page++) {
            const query = `/tasks?org_id=${orgId}&limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
            const response = await call(CAROL, "GET", query);
            expect(response.status).toBe(200);
            const body = tasksResponseSchema.parse(await response.json());
            seen.push(...body.items.map((item) => item.id));
            cursor = body.next_cursor;
            if (cursor === null) break;
        }
        expect(cursor).toBeNull();
        expect(new Set(seen).size).toBe(seen.length);
        expect([...seen]).toEqual([...seen].sort().reverse());
        // A plain member sees only the org-visible tasks.
        const dave = tasksResponseSchema.parse(
            await (await call(DAVE, "GET", `/tasks?org_id=${orgId}`)).json(),
        );
        expect(dave.items.every((item) => item.visibility === "org")).toBe(true);
        expect(dave.items.length).toBeLessThan(seen.length);
    });

    it("refuses bad list queries and outsiders", async () => {
        expect((await call(CAROL, "GET", "/tasks")).status).toBe(400);
        expect((await call(CAROL, "GET", `/tasks?org_id=${orgId}&limit=101`)).status).toBe(400);
        expect((await call(CAROL, "GET", `/tasks?org_id=${orgId}&limit=0`)).status).toBe(400);
        expect((await call(CAROL, "GET", `/tasks?org_id=${orgId}&cursor=nope`)).status).toBe(400);
        expect((await call(ERIN, "GET", `/tasks?org_id=${orgId}`)).status).toBe(404);
    });
});

describe("changing a task", () => {
    it("lets writers retitle and change visibility, and nobody else", async () => {
        const task = taskSchema.parse(await (await create(BOB)).json());
        const patch = (user: string, body: unknown) =>
            call(user, "PATCH", `/tasks/${task.id}`, body);
        const renamed = await patch(ALICE, { title: "Renamed" });
        expect(renamed.status).toBe(200);
        expect(taskSchema.parse(await renamed.json()).title).toBe("Renamed");
        expect((await patch(BOB, { visibility: "org" })).status).toBe(200);
        expect((await patch(CAROL, { title: "Hacked" })).status).toBe(403);
        expect((await patch(DAVE, { title: "Hacked" })).status).toBe(403);
        expect((await patch(ERIN, { title: "Hacked" })).status).toBe(404);
        expect((await patch(BOB, {})).status).toBe(400);
        expect((await patch(BOB, { kind: "sql" })).status).toBe(400);
        expect((await patch(BOB, { slug: "new-slug" })).status).toBe(400);
        const { sql } = h.db.database;
        const audit = await sql`select 1 from audit_log where action = 'task.updated'`;
        expect(audit.length).toBeGreaterThanOrEqual(2);
    });

    it("refuses malformed ids without touching the database", async () => {
        expect((await call(BOB, "GET", "/tasks/not-an-id")).status).toBe(400);
        expect(
            (
                await call(BOB, "PATCH", "/tasks/usr_018f0000-0000-7000-8000-0000000000a1", {
                    title: "x",
                })
            ).status,
        ).toBe(400);
    });
});
