// Goal: people other than the author record whether a task held or was gamed; the author, plain members
// and unassigned reviewers cannot; findings are plain text, never HTML, and never change.
import { attackSchema, attacksResponseSchema } from "@aura/contracts/api/attacks";
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
    >`insert into orgs (kind, slug, name) values ('company', 'atk-http', 'T') returning id`;
    await sql`insert into memberships (org_id, user_id, role) values
        (${org?.id ?? ""}, ${ALICE}, 'owner'), (${org?.id ?? ""}, ${BOB}, 'setter'),
        (${org?.id ?? ""}, ${CAROL}, 'reviewer'), (${org?.id ?? ""}, ${DAVE}, 'member'),
        (${org?.id ?? ""}, ${FRANK}, 'reviewer')`;
    world = taskWorld(h, encodeId("org", org?.id ?? ""), { assigner: ALICE, assignees: [CAROL] });
});
afterAll(async () => {
    await h.drop();
});

const attack = (user: string, versionId: string, body: unknown) =>
    world.call(user, "POST", `/task-versions/${versionId}/attacks`, body);
const inReview = async () => world.inReview(BOB, await world.newTask(BOB, "org"));

describe("recording an attack", () => {
    it("is for a reviewer or owner who did not make the version, on a version in review", async () => {
        const draft = await world.newVersion(BOB, await world.newTask(BOB, "org"));
        expect((await attack(CAROL, draft.id, { outcome: "held", method: "x" })).status).toBe(409);
        const version = await inReview();
        const made = await attack(CAROL, version.id, {
            outcome: "gamed",
            method: "Printed the first token; passes tests 1 to 3.",
        });
        expect(made.status).toBe(201);
        expect(attackSchema.parse(await made.json())).toMatchObject({ outcome: "gamed" });
        expect(
            (await attack(ALICE, version.id, { outcome: "held", method: "Tried." })).status,
        ).toBe(201);
        // The author cannot attack their own version, an unassigned reviewer and a member cannot see it.
        expect((await attack(BOB, version.id, { outcome: "held", method: "Mine." })).status).toBe(
            409,
        );
        expect((await attack(FRANK, version.id, { outcome: "held", method: "x" })).status).toBe(
            404,
        );
        expect((await attack(DAVE, version.id, { outcome: "held", method: "x" })).status).toBe(404);
    });

    it("refuses unknown fields, other outcomes and an empty or oversized method", async () => {
        const version = await inReview();
        for (const body of [
            { outcome: "held", method: "x", extra: 1 },
            { outcome: "maybe", method: "x" },
            { outcome: "held", method: "   " },
            { outcome: "held", method: "x".repeat(4001) },
            { outcome: "held" },
        ]) {
            expect((await attack(CAROL, version.id, body)).status).toBe(400);
        }
    });

    it("lists findings for staff, as text, in order, and nothing for others", async () => {
        const version = await inReview();
        const html = "<img src=x onerror=alert(1)> & **bold**";
        await attack(CAROL, version.id, { outcome: "held", method: html });
        await attack(ALICE, version.id, { outcome: "gamed", method: "second" });
        const read = async (user: string) =>
            world.call(user, "GET", `/task-versions/${version.id}/attacks`);
        const seen = attacksResponseSchema.parse(await (await read(BOB)).json());
        expect(seen.attacks.map((a) => a.outcome)).toEqual(["held", "gamed"]);
        expect(seen.attacks[0]?.method).toBe(html); // stored and returned as text; the page shows it as text
        expect(Object.keys(seen.attacks[0] ?? {}).sort()).toEqual([
            "author_id",
            "created_at",
            "id",
            "method",
            "outcome",
        ]);
        expect((await read(FRANK)).status).toBe(404);
        expect((await read(DAVE)).status).toBe(404);
    });
});
