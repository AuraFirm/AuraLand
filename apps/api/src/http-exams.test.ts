// Goal: the instructor's side of exams through the real HTTP app and PostgreSQL. Staff create an exam with
// its problems, upload a roster as CSV (whole or not at all, with the bad lines named), publish it, and the
// clock moves it; a rostered candidate sees the exam but not its problems or roster; outsiders see nothing;
// nothing changes once it is published except the roster until it opens.

import { randomBytes } from "node:crypto";
import { examSchema, examsResponseSchema, rosterResponseSchema } from "@aura/contracts/api/exams";
import { encodeId } from "@aura/contracts/ids";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { advanceExams } from "./modules/exams/tick.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3"; // plain member of the host
const DAVE = "018f0000-0000-7000-8000-0000000000d4"; // a stranger
const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;
const HOUR = 3_600_000;

let h: Harness;
let host = "";
let hostPublic = "";
let version = "";
beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    for (const [id, name] of [
        [CAROL, "carol"],
        [DAVE, "dave"],
    ] as const) {
        await sql`insert into users (id, email, email_verified_at) values (${id}, ${`${name}@example.com`}, now())`;
    }
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'http-uni', 'Uni') returning id`;
    host = org?.id ?? "";
    hostPublic = encodeId("org", host);
    await sql`insert into memberships (org_id, user_id, role) values
        (${host}, ${ALICE}, 'owner'), (${host}, ${BOB}, 'setter'), (${host}, ${CAROL}, 'member')`;
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${host}, 'http-task', 'algorithmic', 'private', 'T', ${ALICE}) returning id`;
    await sql`alter table task_versions disable trigger task_versions_guard`;
    const [v] = await sql<{ id: string }[]>`insert into task_versions
        (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
        values (${host}, ${task?.id ?? ""}, 1, 'released', ${sql.json({ spec_version: 1 })}, 'Add.', 10, ${randomBytes(32)}, ${ALICE}, ${BOB}, now(), true, now()) returning id`;
    await sql`alter table task_versions enable trigger task_versions_guard`;
    version = encodeId("tsv", v?.id ?? "");
});
afterAll(async () => {
    await h.drop();
});

const call = async (user: string | null, method: string, path: string, body?: unknown) => {
    const headers =
        user === null
            ? browser(null, body === undefined ? {} : { "content-type": "application/json" })
            : browser(
                  (await h.login(user)).token,
                  body === undefined ? {} : { "content-type": "application/json" },
              );
    return h.request(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
};
const iso = (offsetMs: number) => new Date(h.clock.nowUnixMs() + offsetMs).toISOString();

const context = () => ({
    clock: h.clock,
    inTransaction: <T>(work: Parameters<typeof withRequestContext<T>>[2]) =>
        withRequestContext(h.db.database.sql, WORKER, work),
});
const problem = {
    label: "A",
    task_version_id: "",
    points: 100,
    auto_percent: 70,
    rubric: [{ id: "style", label: "Readable", max_points: 30 }],
};
let counter = 0;
const request = (over: Record<string, unknown> = {}) => ({
    title: `Lab ${++counter}`,
    mode: "ai_free",
    duration_s: 3600,
    window_start: iso(2 * HOUR),
    window_end: iso(5 * HOUR),
    problems: [{ ...problem, task_version_id: version }],
    ...over,
});
const create = async (over: Record<string, unknown> = {}) => {
    const response = await call(ALICE, "POST", `/orgs/${hostPublic}/exams`, request(over));
    expect(response.status).toBe(201);
    return examSchema.parse(await response.json());
};
const csv = "email,name,extra_minutes\ncarol@example.com,Carol,15\nerin@example.com,Erin,0\n";

describe("creating an exam", () => {
    it("is for the host's owners and admins, as a draft with its problems", async () => {
        const exam = await create();
        expect(exam).toMatchObject({
            state: "draft",
            can_manage: true,
            roster_size: 0,
            assurance_level: 1,
        });
        expect(exam.problems).toEqual([
            { label: "A", points: 100, auto_percent: 70, rubric: problem.rubric },
        ]);
        expect((await call(BOB, "POST", `/orgs/${hostPublic}/exams`, request())).status).toBe(403); // a setter
        expect((await call(DAVE, "POST", `/orgs/${hostPublic}/exams`, request())).status).toBe(404); // not a member
        expect((await call(null, "POST", `/orgs/${hostPublic}/exams`, request())).status).toBe(401);
    });

    it("refuses a window too short, a rubric that does not add up, level 2 and unknown fields", async () => {
        const bad = (over: Record<string, unknown>) =>
            call(ALICE, "POST", `/orgs/${hostPublic}/exams`, request(over));
        expect((await bad({ window_end: iso(2 * HOUR + 1000) })).status).toBe(400);
        expect(
            (await bad({ problems: [{ ...problem, task_version_id: version, rubric: [] }] }))
                .status,
        ).toBe(400);
        expect((await bad({ assurance_level: 2 })).status).toBe(400);
        expect((await bad({ extra: 1 })).status).toBe(400);
        expect(
            (
                await bad({
                    problems: [
                        { ...problem, task_version_id: "tsv_018f0000-0000-7000-8000-0000000000ff" },
                    ],
                })
            ).status,
        ).toBe(400);
    });
});

describe("the roster", () => {
    it("is replaced as a whole from CSV, named line by line when wrong, and staff's to read", async () => {
        const exam = await create();
        const ok = await call(ALICE, "PUT", `/exams/${exam.id}/roster`, { csv });
        expect(ok.status).toBe(200);
        const read = rosterResponseSchema.parse(
            await (await call(ALICE, "GET", `/exams/${exam.id}/roster`)).json(),
        );
        expect(read.people.map((p) => [p.email, p.extra_minutes])).toEqual([
            ["carol@example.com", 15],
            ["erin@example.com", 0],
        ]);
        const bad = await call(ALICE, "PUT", `/exams/${exam.id}/roster`, {
            csv: "email,name\nnot-an-email,X\ngood@example.com,Y\n",
        });
        expect(bad.status).toBe(400);
        expect(await bad.text()).toContain("line 2");
        const again = rosterResponseSchema.parse(
            await (await call(ALICE, "GET", `/exams/${exam.id}/roster`)).json(),
        );
        expect(again.people).toHaveLength(2); // the bad file wrote nothing
        expect((await call(CAROL, "GET", `/exams/${exam.id}/roster`)).status).toBe(404);
        expect((await call(BOB, "PUT", `/exams/${exam.id}/roster`, { csv })).status).toBe(404); // a setter does not see a draft exam
    });
});

describe("publishing and the clock", () => {
    it("publishes with a problem and a person, freezes the exam, and the clock opens and closes it", async () => {
        const exam = await create();
        expect((await call(ALICE, "POST", `/exams/${exam.id}/publish`)).status).toBe(409); // nobody on the roster
        await call(ALICE, "PUT", `/exams/${exam.id}/roster`, { csv });
        expect((await call(BOB, "POST", `/exams/${exam.id}/publish`)).status).toBe(404);
        const published = await call(ALICE, "POST", `/exams/${exam.id}/publish`);
        expect(published.status).toBe(200);
        expect(examSchema.parse(await published.json()).state).toBe("scheduled");
        expect((await call(ALICE, "PATCH", `/exams/${exam.id}`, { title: "Other" })).status).toBe(
            409,
        );
        expect(
            (
                await call(ALICE, "POST", `/exams/${exam.id}/problems`, {
                    ...problem,
                    label: "B",
                    task_version_id: version,
                    auto_percent: 100,
                    rubric: [],
                })
            ).status,
        ).toBe(409);
        expect(
            (
                await call(ALICE, "PUT", `/exams/${exam.id}/roster`, {
                    csv: `${csv}fay@example.com,Fay,0\n`,
                })
            ).status,
        ).toBe(200); // until it opens
        h.clock.advance(2 * HOUR + 1000);
        await advanceExams(context());
        expect(
            examSchema.parse(await (await call(ALICE, "GET", `/exams/${exam.id}`)).json()).state,
        ).toBe("open");
        expect((await call(ALICE, "PUT", `/exams/${exam.id}/roster`, { csv })).status).toBe(409);
        expect((await call(ALICE, "POST", `/exams/${exam.id}/release-grades`)).status).toBe(409); // not closed yet
        h.clock.advance(3 * HOUR);
        await advanceExams(context());
        expect((await call(ALICE, "POST", `/exams/${exam.id}/release-grades`)).status).toBe(200);
        expect(
            examSchema.parse(await (await call(ALICE, "GET", `/exams/${exam.id}`)).json()),
        ).toMatchObject({ state: "released" });
    });
});

describe("who sees an exam", () => {
    it("shows a rostered candidate the exam without problems or roster, and an outsider nothing", async () => {
        const exam = await create();
        await call(ALICE, "PUT", `/exams/${exam.id}/roster`, { csv });
        expect((await call(CAROL, "GET", `/exams/${exam.id}`)).status).toBe(404); // a draft is the staff's
        await call(ALICE, "POST", `/exams/${exam.id}/publish`);
        const seen = examSchema.parse(await (await call(CAROL, "GET", `/exams/${exam.id}`)).json());
        expect(seen).toMatchObject({ problems: null, roster_size: null, can_manage: false });
        expect((await call(DAVE, "GET", `/exams/${exam.id}`)).status).toBe(404);
        const list = examsResponseSchema.parse(await (await call(CAROL, "GET", "/exams")).json());
        expect(list.exams.map((e) => e.id)).toContain(exam.id);
        const dave = examsResponseSchema.parse(await (await call(DAVE, "GET", "/exams")).json());
        expect(dave.exams).toEqual([]);
    });
});
