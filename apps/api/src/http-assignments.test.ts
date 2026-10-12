// Goal: setters and reviewers see and touch only the tasks they created or were assigned, owners and
// admins see all, only owners and admins assign (and only setters and reviewers of the organization),
// and taking an assignment away takes the access away.
import { assignmentsResponseSchema } from "@aura/contracts/api/assignments";
import { taskSchema, tasksResponseSchema } from "@aura/contracts/api/tasks";
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3"; // reviewer
const DAVE = "018f0000-0000-7000-8000-0000000000d4"; // member
const FRANK = "018f0000-0000-7000-8000-0000000000f6"; // second setter

let h: Harness;
let orgId = "";
beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    for (const [id, name] of [
        [CAROL, "carol"],
        [DAVE, "dave"],
        [FRANK, "frank"],
    ] as const)
        await sql`insert into users (id, email, email_verified_at) values (${id}, ${`${name}@example.com`}, now())`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'assign-team', 'A') returning id`;
    await sql`insert into memberships (org_id, user_id, role) values
        (${org?.id ?? ""}, ${ALICE}, 'owner'), (${org?.id ?? ""}, ${BOB}, 'setter'),
        (${org?.id ?? ""}, ${CAROL}, 'reviewer'), (${org?.id ?? ""}, ${DAVE}, 'member'),
        (${org?.id ?? ""}, ${FRANK}, 'setter')`;
    orgId = encodeId("org", org?.id ?? "");
});
afterAll(async () => {
    await h.drop();
});

const call = async (user: string, method: string, path: string, body?: unknown) => {
    const { token } = await h.login(user);
    return h.request(path, {
        method,
        headers: browser(token, { "content-type": "application/json" }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
};
let counter = 0;
async function newTask(user: string) {
    const response = await call(user, "POST", "/tasks", {
        org_id: orgId,
        slug: `assigned-${++counter}`,
        title: "A task",
        kind: "algorithmic",
        visibility: "private",
    });
    return taskSchema.parse(await response.json());
}
const assign = (actor: string, taskId: string, user: string) =>
    call(actor, "POST", `/tasks/${taskId}/assignments`, { user_id: encodeId("usr", user) });
const status = async (user: string, path: string) => (await call(user, "GET", path)).status;

describe("who sees a task", () => {
    it("shows a setter only their own and assigned tasks, and owners all", async () => {
        const bobs = await newTask(BOB);
        expect(await status(FRANK, `/tasks/${bobs.id}`)).toBe(404);
        expect(await status(ALICE, `/tasks/${bobs.id}`)).toBe(200);
        expect((await assign(ALICE, bobs.id, FRANK)).status).toBe(201);
        expect(await status(FRANK, `/tasks/${bobs.id}`)).toBe(200);
        expect((await call(FRANK, "POST", `/tasks/${bobs.id}/versions`, {})).status).toBe(201);
        const list = tasksResponseSchema.parse(
            await (await call(FRANK, "GET", `/tasks?org_id=${orgId}`)).json(),
        );
        expect(list.items.map((t) => t.id)).toContain(bobs.id);
    });

    it("shows a reviewer only assigned tasks, and nothing again after unassigning", async () => {
        const task = await newTask(BOB);
        const version = await call(BOB, "POST", `/tasks/${task.id}/versions`, {});
        expect(version.status).toBe(201);
        expect(await status(CAROL, `/tasks/${task.id}`)).toBe(404);
        expect(await status(CAROL, `/tasks/${task.id}/versions`)).toBe(404);
        await assign(ALICE, task.id, CAROL);
        expect(await status(CAROL, `/tasks/${task.id}/versions`)).toBe(200);
        const removed = await call(
            ALICE,
            "DELETE",
            `/tasks/${task.id}/assignments/${encodeId("usr", CAROL)}`,
        );
        expect(removed.status).toBe(204);
        expect(await status(CAROL, `/tasks/${task.id}`)).toBe(404);
        const other = await newTask(BOB);
        const none = tasksResponseSchema.parse(
            await (await call(CAROL, "GET", `/tasks?org_id=${orgId}`)).json(),
        );
        expect(none.items.map((t) => t.id)).not.toContain(other.id);
    });
});

describe("assigning", () => {
    it("is for owners and admins only, and only for setters and reviewers", async () => {
        const task = await newTask(BOB);
        expect((await assign(BOB, task.id, CAROL)).status).toBe(404);
        expect((await assign(CAROL, task.id, CAROL)).status).toBe(404);
        expect((await assign(DAVE, task.id, CAROL)).status).toBe(404);
        expect((await assign(ALICE, task.id, DAVE)).status).toBe(409);
        expect((await assign(ALICE, task.id, "018f0000-0000-7000-8000-0000000000aa")).status).toBe(
            409,
        );
        const list = assignmentsResponseSchema.parse(
            await (await call(ALICE, "GET", `/tasks/${task.id}/assignments`)).json(),
        );
        expect(list.assignments).toEqual([]);
    });

    it("is idempotent, audited, and visible to the assigned person", async () => {
        const task = await newTask(BOB);
        await assign(ALICE, task.id, CAROL);
        expect((await assign(ALICE, task.id, CAROL)).status).toBe(201);
        const mine = assignmentsResponseSchema.parse(
            await (await call(CAROL, "GET", `/tasks/${task.id}/assignments`)).json(),
        );
        expect(mine.assignments.length).toBe(1);
        const audit = await h.db.database
            .sql`select seq from audit_log where action = 'task.staff_assigned'`;
        expect(audit.length).toBeGreaterThanOrEqual(1);
        expect(
            (await call(ALICE, "DELETE", `/tasks/${task.id}/assignments/${encodeId("usr", DAVE)}`))
                .status,
        ).toBe(404);
    });
});
