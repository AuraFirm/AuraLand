// Goal: submissions end to end through the real HTTP app and PostgreSQL. Only members of the task's
// organization may submit, only to released versions, only in a language the spec allows; each
// submission is queued as exactly one judge job in the same transaction; people are limited to six a
// minute per task; a full queue answers 503 and leaves no submission behind; owners and organization
// owners/admins can read a submission, nobody else; and no response carries hidden material.

import { submissionSchema, submissionsResponseSchema } from "@aura/contracts/api/submissions";
import { versionSchema } from "@aura/contracts/api/task-versions";
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, createHarness, type Harness } from "./http-harness.ts";
import { taskWorld } from "./http-task-support.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
const DAVE = "018f0000-0000-7000-8000-0000000000d4";
const ERIN = "018f0000-0000-7000-8000-0000000000e5";
const REASON = "No sandbox exists yet; reviewed by hand before release.";
const SOURCE = "#include <iostream>\nint main(){ int a,b; std::cin>>a>>b; std::cout<<a+b; }\n";

let h: Harness;
let world: ReturnType<typeof taskWorld>;
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
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'submit-team', 'Submit Team') returning id`;
    const [other] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'elsewhere', 'Elsewhere') returning id`;
    // ALICE owns, BOB sets, CAROL reviews, DAVE is a plain member; ERIN belongs to another organization.
    await sql`insert into memberships (org_id, user_id, role) values
        (${org?.id ?? ""}, ${ALICE}, 'owner'), (${org?.id ?? ""}, ${BOB}, 'setter'),
        (${org?.id ?? ""}, ${CAROL}, 'reviewer'), (${org?.id ?? ""}, ${DAVE}, 'member'),
        (${other?.id ?? ""}, ${ERIN}, 'owner')`;
    world = taskWorld(h, encodeId("org", org?.id ?? ""), {
        assigner: ALICE,
        assignees: [CAROL],
    });
});
afterAll(async () => {
    await h.drop();
});

async function releasedVersion() {
    const task = await world.newTask(BOB, "org");
    const version = await world.inReview(BOB, task);
    await world.call(CAROL, "POST", `/task-versions/${version.id}/review`, { outcome: "approved" });
    const released = await world.call(CAROL, "POST", `/task-versions/${version.id}/release`, {
        waiver_reason: REASON,
    });
    expect(released.status).toBe(200);
    return versionSchema.parse(await released.json());
}

const submit = (
    user: string,
    versionId: string,
    body: unknown = { language: "cpp", source: SOURCE },
) => world.call(user, "POST", `/task-versions/${versionId}/submissions`, body);

describe("submitting", () => {
    it("queues one judge job for each submission and audits it", async () => {
        const version = await releasedVersion();
        const response = await submit(DAVE, version.id);
        expect(response.status).toBe(201);
        const made = submissionSchema.parse(await response.json());
        expect([made.state, made.verdict, made.source, made.tests]).toEqual([
            "queued",
            null,
            null,
            null,
        ]);
        const { sql } = h.db.database;
        const jobs =
            await sql`select kind, queue, state, payload from jobs where dedupe_key = ${`submission:${made.id.slice(4)}`}`;
        expect(jobs.length).toBe(1);
        expect(jobs[0]?.["kind"]).toBe("judge.tier1");
        expect(jobs[0]?.["queue"]).toBe("judge");
        const audit =
            await sql`select 1 from audit_log where action = 'submission.created' and target = ${made.id}`;
        expect(audit.length).toBe(1);
    });

    it("refuses outsiders, unreleased versions, wrong languages and bad bodies", async () => {
        const version = await releasedVersion();
        expect((await submit(ERIN, version.id)).status).toBe(404);
        const draft = await world.newVersion(BOB);
        expect((await submit(BOB, draft.id)).status).toBe(409);
        // A version in review has a spec and a bundle but is not released.
        const inReview = await world.inReview(BOB);
        expect((await submit(BOB, inReview.id)).status).toBe(409);
        expect(
            (await submit(DAVE, version.id, { language: "python3", source: SOURCE })).status,
        ).toBe(400);
        for (const bad of [
            {},
            { language: "cpp" },
            { language: "cpp", source: "" },
            { language: "ruby", source: SOURCE },
            { language: "cpp", source: SOURCE, extra: 1 },
            { language: "cpp", source: "a\0b" },
            { language: "cpp", source: "x".repeat(262145) },
            { language: "cpp", source: "\u00e9".repeat(131073) },
        ]) {
            expect(
                (await submit(DAVE, version.id, bad)).status,
                JSON.stringify(bad).slice(0, 40),
            ).toBe(400);
        }
        expect((await submit(DAVE, "not-an-id")).status).toBe(400);
    });

    it("accepts the largest allowed source, even when escaping makes the body bigger than the cap", async () => {
        const version = await releasedVersion();
        // 256 KiB of quote characters become two bytes each in JSON.
        const big = '"'.repeat(262144);
        expect((await submit(BOB, version.id, { language: "cpp", source: big })).status).toBe(201);
        expect((await submit(BOB, version.id, { language: "cpp", source: `${big}"` })).status).toBe(
            400,
        );
    });
});

describe("submitting: limits and load", () => {
    it("limits a person to six a minute per task", async () => {
        const version = await releasedVersion();
        const codes: number[] = [];
        for (let n = 0; n < 8; n++) codes.push((await submit(DAVE, version.id)).status);
        expect(codes.filter((c) => c === 201).length).toBe(6);
        expect(codes.filter((c) => c === 429).length).toBe(2);
        // Another person, and another task, are not affected.
        expect((await submit(BOB, version.id)).status).toBe(201);
        const other = await releasedVersion();
        expect((await submit(DAVE, other.id)).status).toBe(201);
    });

    it("refuses with 503 and a retry hint when the judge queue is full, leaving nothing behind", async () => {
        const version = await releasedVersion();
        const { sql } = h.db.database;
        await sql`insert into jobs (kind, queue, payload, run_after, created_at, updated_at)
            select 'fill.job', 'judge', '{}'::jsonb, now(), now(), now() from generate_series(1, 1000)`;
        const before = await sql`select count(*)::int as n from submissions`;
        const response = await submit(CAROL, version.id);
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("30");
        const after = await sql`select count(*)::int as n from submissions`;
        expect(after[0]?.["n"]).toBe(before[0]?.["n"]);
        await sql`delete from jobs where kind = 'fill.job'`;
        expect((await submit(CAROL, version.id)).status).toBe(201);
    });
});

describe("reading", () => {
    it("shows the source to its owner and to organization owners, never to anyone else", async () => {
        const version = await releasedVersion();
        const made = submissionSchema.parse(await (await submit(DAVE, version.id)).json());
        const read = async (user: string) => world.call(user, "GET", `/submissions/${made.id}`);
        const own = submissionSchema.parse(await (await read(DAVE)).json());
        expect(own.source).toBe(SOURCE);
        expect(own.tests).toEqual([]);
        expect((await read(ALICE)).status).toBe(200);
        for (const stranger of [BOB, CAROL, ERIN]) expect((await read(stranger)).status).toBe(404);
        expect((await world.call(DAVE, "GET", "/submissions/not-an-id")).status).toBe(400);
    });

    it("lists only my submissions to a version, newest first, paging without gaps", async () => {
        const version = await releasedVersion();
        for (let n = 0; n < 4; n++) await submit(BOB, version.id);
        await submit(CAROL, version.id);
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 10; page++) {
            const query = `/submissions?task_version_id=${version.id}&limit=3${cursor === null ? "" : `&cursor=${cursor}`}`;
            const body = submissionsResponseSchema.parse(
                await (await world.call(BOB, "GET", query)).json(),
            );
            seen.push(...body.items.map((item) => item.id));
            cursor = body.next_cursor;
            if (cursor === null) break;
        }
        expect(seen.length).toBe(4);
        expect(new Set(seen).size).toBe(4);
        expect([...seen]).toEqual([...seen].sort().reverse());
        expect((await world.call(BOB, "GET", "/submissions")).status).toBe(400);
    });
});

describe("database rules", () => {
    it("never changes a finished submission's source or verdict, and ties a verdict to judging", async () => {
        const version = await releasedVersion();
        const made = submissionSchema.parse(await (await submit(DAVE, version.id)).json());
        const id = made.id.slice(4);
        const { sql } = h.db.database;
        await expect(sql`update submissions set source = 'x' where id = ${id}`).rejects.toThrow(
            /keeps its source/,
        );
        await expect(sql`update submissions set state = 'judged' where id = ${id}`).rejects.toThrow(
            /cannot move|judged_pair/,
        );
        await sql`update submissions set state = 'judging', updated_at = now() where id = ${id}`;
        await sql`update submissions set state = 'judged', verdict = 'AC', judged_at = now() where id = ${id}`;
        await expect(sql`update submissions set verdict = 'WA' where id = ${id}`).rejects.toThrow(
            /finished submission/,
        );
    });
});
