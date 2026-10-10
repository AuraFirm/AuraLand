// Goal: the life of a version through the public API: submit, review, release (with a recorded
// waiver, since there is no sandbox yet), retire. Separation of duties holds (creators never review
// or release their own version), powerful steps need a fresh passkey check, an approval never
// outlives the content it approved, only one version of a task is released at a time, released
// versions cannot change, and two people acting at once cannot both win.

import { versionSchema } from "@aura/contracts/api/task-versions";
import { taskSchema } from "@aura/contracts/api/tasks";
import { problemSchema } from "@aura/contracts/errors";
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { SPEC, taskWorld } from "./http-task-support.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
const DAVE = "018f0000-0000-7000-8000-0000000000d4";
const FRANK = "018f0000-0000-7000-8000-0000000000f6";
const REASON = "No sandbox exists yet; the author and reviewer checked the tests by hand.";

let h: Harness;
let world: ReturnType<typeof taskWorld>;
beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    for (const [id, name] of [
        [CAROL, "carol"],
        [DAVE, "dave"],
        [FRANK, "frank"],
    ] as const) {
        await sql`insert into users (id, email, email_verified_at) values (${id}, ${`${name}@example.com`}, now())`;
    }
    const [org] = await sql<{ id: string }[]>`
        insert into orgs (kind, slug, name) values ('company', 'review-team', 'Review Team') returning id`;
    // ALICE owns, BOB sets, CAROL and FRANK review, DAVE is a plain member.
    await sql`insert into memberships (org_id, user_id, role) values
        (${org?.id ?? ""}, ${ALICE}, 'owner'), (${org?.id ?? ""}, ${BOB}, 'setter'),
        (${org?.id ?? ""}, ${CAROL}, 'reviewer'), (${org?.id ?? ""}, ${FRANK}, 'reviewer'),
        (${org?.id ?? ""}, ${DAVE}, 'member')`;
    world = taskWorld(h, encodeId("org", org?.id ?? ""));
});
afterAll(async () => {
    await h.drop();
});

const post = (user: string, versionId: string, action: string, body?: unknown) =>
    world.call(user, "POST", `/task-versions/${versionId}/${action}`, body);
const approve = (user: string, versionId: string) =>
    post(user, versionId, "review", { outcome: "approved" });
const bodyOf = async (response: Response) => versionSchema.parse(await response.json());

describe("submitting for review", () => {
    it("needs a bundle, a statement and a spec, and a writer", async () => {
        const noBundle = await world.newVersion(BOB);
        expect((await post(BOB, noBundle.id, "submit-review")).status).toBe(409);
        const noContent = await world.uploadedVersion(BOB);
        expect((await post(BOB, noContent.id, "submit-review")).status).toBe(409);
        await world.withContent(BOB, noContent);
        expect((await post(CAROL, noContent.id, "submit-review")).status).toBe(403);
        expect((await post(DAVE, noContent.id, "submit-review")).status).toBe(404);
        const submitted = await bodyOf(await post(BOB, noContent.id, "submit-review"));
        expect(submitted.state).toBe("in_review");
        expect((await post(BOB, noContent.id, "submit-review")).status).toBe(409);
    });

    it("freezes editing while in review", async () => {
        const version = await world.inReview(BOB);
        const edit = await world.call(BOB, "PATCH", `/task-versions/${version.id}`, {
            statement: "x",
        });
        expect(edit.status).toBe(409);
    });
});

describe("reviewing", () => {
    it("lets reviewers approve or ask for changes, and nobody else", async () => {
        const version = await world.inReview(BOB);
        expect((await approve(BOB, version.id)).status).toBe(403);
        expect((await approve(DAVE, version.id)).status).toBe(404);
        const asked = await post(CAROL, version.id, "review", {
            outcome: "changes_requested",
            comment: "Add a sample.",
        });
        expect((await bodyOf(asked)).state).toBe("uploaded");
        // The writer fixes it and submits again.
        await world.withContent(BOB, version);
        expect((await bodyOf(await post(BOB, version.id, "submit-review"))).state).toBe(
            "in_review",
        );
    });

    it("never lets a creator review their own version", async () => {
        const task = await world.newTask(ALICE);
        const version = await world.inReview(ALICE, task);
        const own = await approve(ALICE, version.id);
        expect(own.status).toBe(403);
        expect((await post(ALICE, version.id, "review", { outcome: "rejected" })).status).toBe(403);
        expect((await approve(CAROL, version.id)).status).toBe(200);
    });

    it("rejects a version for good", async () => {
        const version = await world.inReview(BOB);
        const rejected = await post(CAROL, version.id, "review", {
            outcome: "rejected",
            comment: "No.",
        });
        expect((await bodyOf(rejected)).state).toBe("rejected");
        expect((await post(BOB, version.id, "submit-review")).status).toBe(409);
        expect(
            (await world.call(BOB, "PATCH", `/task-versions/${version.id}`, { statement: "x" }))
                .status,
        ).toBe(409);
    });

    it("refuses reviews of versions that are not in review, and bad bodies", async () => {
        const draft = await world.newVersion(BOB);
        expect((await approve(CAROL, draft.id)).status).toBe(409);
        const inReview = await world.inReview(BOB);
        expect((await post(CAROL, inReview.id, "review", { outcome: "maybe" })).status).toBe(400);
        expect(
            (await post(CAROL, inReview.id, "review", { outcome: "approved", extra: 1 })).status,
        ).toBe(400);
        expect(
            (await post(CAROL, inReview.id, "review", { outcome: "approved", comment: "" })).status,
        ).toBe(400);
    });
});

describe("releasing", () => {
    it("needs an approval, a reason for the waiver, and a fresh passkey check", async () => {
        const version = await world.inReview(BOB);
        const release = (user: string, body: unknown = { waiver_reason: REASON }) =>
            post(user, version.id, "release", body);
        const early = await release(CAROL);
        expect(early.status).toBe(409);
        // The application says why; the database would only say "changed first".
        expect(problemSchema.parse(await early.json()).title).toMatch(/approving review/);
        await approve(CAROL, version.id);
        expect((await release(BOB)).status).toBe(403);
        expect((await release(DAVE)).status).toBe(404);
        expect((await release(CAROL, {})).status).toBe(400);
        expect((await release(CAROL, { waiver_reason: "short" })).status).toBe(400);

        // A passkey check that is older than 15 minutes is not enough.
        const { token } = await h.login(CAROL);
        h.clock.advance(16 * 60 * 1000);
        const stale = await h.request(`/task-versions/${version.id}/release`, {
            method: "POST",
            headers: browser(token, { "content-type": "application/json" }),
            body: JSON.stringify({ waiver_reason: REASON }),
        });
        expect(stale.status).toBe(403);
        expect(problemSchema.parse(await stale.json()).code).toBe("step_up_required");

        const done = await bodyOf(await release(CAROL));
        expect(done.state).toBe("released");
        expect(done.waived).toBe(true);
        expect(done.released_at).not.toBeNull();
        const { sql } = h.db.database;
        const audit =
            await sql`select detail from audit_log where action = 'task_version.released' order by seq desc limit 1`;
        expect(JSON.stringify(audit[0]?.["detail"])).toContain("No sandbox exists yet");
    });

    it("never lets a creator release their own version, even when someone else approved it", async () => {
        const task = await world.newTask(ALICE);
        const version = await world.inReview(ALICE, task);
        await approve(CAROL, version.id);
        expect((await post(ALICE, version.id, "release", { waiver_reason: REASON })).status).toBe(
            403,
        );
    });

    it("does not let an approval outlive the content it approved", async () => {
        const version = await world.inReview(BOB);
        await approve(CAROL, version.id);
        await post(FRANK, version.id, "review", { outcome: "changes_requested" });
        await world.withContent(BOB, version);
        await post(BOB, version.id, "submit-review");
        const attempt = await post(CAROL, version.id, "release", { waiver_reason: REASON });
        expect(attempt.status).toBe(409);
        await approve(FRANK, version.id);
        expect((await post(CAROL, version.id, "release", { waiver_reason: REASON })).status).toBe(
            200,
        );
    });
});

describe("releasing: one current version", () => {
    it("keeps one released version per task and freezes it", async () => {
        const task = await world.newTask(BOB);
        const first = await world.inReview(BOB, task);
        await approve(CAROL, first.id);
        await post(CAROL, first.id, "release", { waiver_reason: REASON });
        const second = await world.inReview(BOB, task);
        await approve(CAROL, second.id);
        expect((await post(CAROL, second.id, "release", { waiver_reason: REASON })).status).toBe(
            200,
        );
        expect((await world.stateOf(CAROL, first.id)).state).toBe("retired");
        expect((await world.stateOf(CAROL, second.id)).state).toBe("released");
        for (const change of [{ statement: "Changed" }, { spec: SPEC }]) {
            expect(
                (await world.call(BOB, "PATCH", `/task-versions/${second.id}`, change)).status,
            ).toBe(409);
        }
        const shown = await world.call(CAROL, "GET", `/tasks/${task.id}`);
        const taskBody = taskSchema.parse(await shown.json());
        expect(taskBody.released_version?.seq).toBe(second.seq);
    });

    it("lets only one of two simultaneous releases win", async () => {
        const version = await world.inReview(BOB);
        await approve(CAROL, version.id);
        await approve(FRANK, version.id);
        const [one, two] = await Promise.all([
            post(CAROL, version.id, "release", { waiver_reason: REASON }),
            post(FRANK, version.id, "release", { waiver_reason: REASON }),
        ]);
        expect([one.status, two.status].sort()).toEqual([200, 409]);
    });
});

describe("retiring and abandoning", () => {
    it("retires a released version with a fresh check, and only reviewers can", async () => {
        const version = await world.inReview(BOB);
        await approve(CAROL, version.id);
        await post(CAROL, version.id, "release", { waiver_reason: REASON });
        expect((await post(BOB, version.id, "retire")).status).toBe(403);
        // A plain member cannot even see a private task's release.
        expect((await post(DAVE, version.id, "retire")).status).toBe(404);
        expect((await bodyOf(await post(CAROL, version.id, "retire"))).state).toBe("retired");
        expect((await post(CAROL, version.id, "retire")).status).toBe(409);
    });

    it("lets writers abandon a draft or uploaded version but not one in review", async () => {
        const draft = await world.newVersion(BOB);
        expect((await bodyOf(await post(BOB, draft.id, "abandon"))).state).toBe("rejected");
        const uploaded = await world.uploadedVersion(BOB);
        expect((await post(CAROL, uploaded.id, "abandon")).status).toBe(403);
        expect((await bodyOf(await post(BOB, uploaded.id, "abandon"))).state).toBe("rejected");
        const inReview = await world.inReview(BOB);
        expect((await post(BOB, inReview.id, "abandon")).status).toBe(409);
    });
});
