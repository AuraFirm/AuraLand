// Goal: the people who work on a task discuss its versions in comments: setters and reviewers on tasks
// they made or were assigned, owners and admins everywhere, nobody else (not even a plain member who
// can read the released version). Comments are rendered safely, replies stay one level deep, and a
// comment never changes.
import { commentSchema, commentsResponseSchema } from "@aura/contracts/api/comments";
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, createHarness, type Harness } from "./http-harness.ts";
import { taskWorld } from "./http-task-support.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3"; // reviewer, assigned
const DAVE = "018f0000-0000-7000-8000-0000000000d4"; // plain member
const FRANK = "018f0000-0000-7000-8000-0000000000f6"; // reviewer, not assigned

let h: Harness;
let world: ReturnType<typeof taskWorld>;
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
    >`insert into orgs (kind, slug, name) values ('company', 'talk-team', 'T') returning id`;
    await sql`insert into memberships (org_id, user_id, role) values
        (${org?.id ?? ""}, ${ALICE}, 'owner'), (${org?.id ?? ""}, ${BOB}, 'setter'),
        (${org?.id ?? ""}, ${CAROL}, 'reviewer'), (${org?.id ?? ""}, ${DAVE}, 'member'),
        (${org?.id ?? ""}, ${FRANK}, 'reviewer')`;
    world = taskWorld(h, encodeId("org", org?.id ?? ""), { assigner: ALICE, assignees: [CAROL] });
});
afterAll(async () => {
    await h.drop();
});

const post = (user: string, versionId: string, body: unknown) =>
    world.call(user, "POST", `/task-versions/${versionId}/comments`, body);
const list = async (user: string, versionId: string) =>
    commentsResponseSchema.parse(
        await (await world.call(user, "GET", `/task-versions/${versionId}/comments`)).json(),
    );

describe("who may discuss a version", () => {
    it("lets staff and owners write and read, and shows nothing to anyone else", async () => {
        const version = await world.newVersion(BOB, await world.newTask(BOB, "org"));
        expect((await post(BOB, version.id, { body: "First draft is up." })).status).toBe(201);
        expect((await post(CAROL, version.id, { body: "Looking now." })).status).toBe(201);
        expect((await post(ALICE, version.id, { body: "Thanks both." })).status).toBe(201);
        expect((await list(CAROL, version.id)).comments.length).toBe(3);
        // FRANK is a reviewer who is not assigned: the version does not exist for them.
        expect((await post(FRANK, version.id, { body: "hi" })).status).toBe(404);
        expect(
            (await world.call(FRANK, "GET", `/task-versions/${version.id}/comments`)).status,
        ).toBe(404);
        // DAVE is a plain member of an org-visible task, but never sees a draft version.
        expect((await post(DAVE, version.id, { body: "hi" })).status).toBe(404);
    });

    it("keeps comments from a plain member even on a released version", async () => {
        const task = await world.newTask(BOB, "org");
        const version = await world.inReview(BOB, task);
        await world.call(CAROL, "POST", `/task-versions/${version.id}/review`, {
            outcome: "approved",
        });
        const released = await world.call(CAROL, "POST", `/task-versions/${version.id}/release`, {
            waiver_reason: "Checked by hand; no sandbox exists yet.",
        });
        expect(released.status).toBe(200);
        await post(BOB, version.id, { body: "Private note." });
        expect((await post(DAVE, version.id, { body: "hi" })).status).toBe(403);
        expect((await list(DAVE, version.id)).comments).toEqual([]);
    });
});

describe("writing", () => {
    it("renders Markdown safely, keeps replies one level deep and refuses bad bodies", async () => {
        const version = await world.newVersion(BOB, await world.newTask(BOB));
        const first = commentSchema.parse(
            await (
                await post(BOB, version.id, {
                    body: "# Hi\n\n<script>alert(1)</script> [x](javascript:alert(1))",
                })
            ).json(),
        );
        expect(first.body_html).toContain("<h3>Hi</h3>");
        expect(first.body_html).not.toMatch(/<script|href="javascript:/i);
        const reply = await post(CAROL, version.id, { body: "Reply", parent_id: first.id });
        expect(reply.status).toBe(201);
        const replyBody = commentSchema.parse(await reply.json());
        expect(
            (await post(BOB, version.id, { body: "Too deep", parent_id: replyBody.id })).status,
        ).toBe(400);
        const other = await world.newVersion(BOB, await world.newTask(BOB));
        expect(
            (await post(BOB, other.id, { body: "Wrong thread", parent_id: first.id })).status,
        ).toBe(400);
        for (const bad of [
            { body: "" },
            { body: "x".repeat(8001) },
            { body: "ok", extra: 1 },
            {},
        ]) {
            expect((await post(BOB, version.id, bad)).status, JSON.stringify(bad)).toBe(400);
        }
        const audit = await h.db.database
            .sql`select seq from audit_log where action = 'version.commented'`;
        expect(audit.length).toBeGreaterThanOrEqual(2);
    });

    it("never lets a comment change or disappear, and limits how fast a person writes", async () => {
        const version = await world.newVersion(BOB, await world.newTask(BOB));
        const made = commentSchema.parse(
            await (await post(BOB, version.id, { body: "Once." })).json(),
        );
        const { sql } = h.db.database;
        await expect(sql`update version_comments set body = 'changed'`).rejects.toThrow(
            /never changes/,
        );
        await expect(sql`delete from version_comments`).rejects.toThrow(/never changes/);
        expect(made.id).toMatch(/^cmt_/);
        h.clock.advance(61_000);
        const statuses: number[] = [];
        for (let n = 0; n < 21; n++)
            statuses.push((await post(BOB, version.id, { body: `n${n}` })).status);
        expect(statuses.filter((s) => s === 201).length).toBe(20);
        expect(statuses[20]).toBe(429);
    });
});
