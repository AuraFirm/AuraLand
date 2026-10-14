// Goal: clarifications through the real HTTP app and PostgreSQL. A registered contestant asks while the
// contest runs; the question is private until the host's staff answer it, once, to the asker alone or to
// everyone; strangers and other contestants see only public answers; limits and the closed window hold;
// no response names the asker.

import { randomBytes } from "node:crypto";
import {
    clarificationSchema,
    clarificationsResponseSchema,
} from "@aura/contracts/api/clarifications";
import { contestSchema } from "@aura/contracts/api/contests";
import { decodeId, encodeId } from "@aura/contracts/ids";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { advanceContests } from "./modules/contests/tick.ts";

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

let counter = 0;
const request = (over: Record<string, unknown> = {}) => ({
    slug: `http-contest-${++counter}`,
    title: "Spring Open",
    rules: { format: "icpc" },
    starts_at: iso(2 * HOUR),
    ends_at: iso(7 * HOUR),
    freeze_at: iso(6 * HOUR),
    problems: [{ label: "A", task_version_id: version }],
    ...over,
});
const create = async (over: Record<string, unknown> = {}) =>
    contestSchema.parse(
        await (await call(ALICE, "POST", `/orgs/${hostPublic}/contests`, request(over))).json(),
    );
const published = async (over: Record<string, unknown> = {}) => {
    const contest = await create(over);
    expect((await call(ALICE, "POST", `/contests/${contest.id}/publish`)).status).toBe(200);
    return contest;
};

const context = () => ({
    clock: h.clock,
    inTransaction: <T>(work: Parameters<typeof withRequestContext<T>>[2]) =>
        withRequestContext(h.db.database.sql, WORKER, work),
});
const runningContest = async () => {
    const contest = await published();
    h.clock.advance(2 * HOUR + 1000);
    await advanceContests(context());
    for (const user of [DAVE, CAROL]) {
        expect((await call(user, "POST", `/contests/${contest.id}/registrations`)).status).toBe(
            201,
        );
    }
    return contest;
};
const ask = (user: string, contest: string, body: Record<string, unknown>) =>
    call(user, "POST", `/contests/${contest}/clarifications`, body);
const asked = async (user: string, contest: string, question = "Is n at most 10^5?") =>
    clarificationSchema.parse(await (await ask(user, contest, { question })).json());
const listFor = async (user: string | null, contest: string) =>
    clarificationsResponseSchema.parse(
        await (await call(user, "GET", `/contests/${contest}/clarifications`)).json(),
    ).items;
const answer = (user: string, contest: string, id: string, body: Record<string, unknown>) =>
    call(user, "POST", `/contests/${contest}/clarifications/${id}/answer`, body);

describe("asking", () => {
    it("is for a registered contestant while the contest runs, and stays private until answered", async () => {
        const contest = await runningContest();
        const response = await ask(DAVE, contest.id, {
            question: "Is n at most 10^5?",
            problem: "A",
        });
        expect(response.status).toBe(201);
        const mine = clarificationSchema.parse(await response.json());
        expect(mine).toMatchObject({ mine: true, public: false, answer: null, problem: "A" });
        expect((await listFor(DAVE, contest.id)).map((c) => c.id)).toEqual([mine.id]);
        expect(await listFor(CAROL, contest.id)).toEqual([]); // another contestant
        expect(await listFor(null, contest.id)).toEqual([]); // the public
        const staff = await listFor(ALICE, contest.id);
        expect(staff.map((c) => [c.id, c.mine])).toEqual([[mine.id, false]]);
        expect(JSON.stringify(staff)).not.toContain(DAVE); // the asker is never named
    });

    it("refuses the unregistered, bad input, unknown problems and the signed-out", async () => {
        const contest = await runningContest();
        expect((await ask(BOB, contest.id, { question: "hi" })).status).toBe(404); // not registered
        expect((await ask(DAVE, contest.id, { question: "" })).status).toBe(400);
        expect((await ask(DAVE, contest.id, { question: "   " })).status).toBe(400);
        expect((await ask(DAVE, contest.id, { question: "x".repeat(1001) })).status).toBe(400);
        expect((await ask(DAVE, contest.id, { question: "ok", extra: 1 })).status).toBe(400);
        expect((await ask(DAVE, contest.id, { question: "ok", problem: "a" })).status).toBe(400);
        expect((await ask(DAVE, contest.id, { question: "ok", problem: "Z" })).status).toBe(404);
        const out = await h.request(`/contests/${contest.id}/clarifications`, {
            method: "POST",
            headers: browser(null, { "content-type": "application/json" }),
            body: JSON.stringify({ question: "ok" }),
        });
        expect(out.status).toBe(401);
    });

    it("stops after the contest and caps how many one person may ask", async () => {
        const contest = await runningContest();
        for (const count of [6, 6, 6, 2]) {
            for (let i = 0; i < count; i++) {
                expect((await ask(DAVE, contest.id, { question: `q${i}` })).status).toBe(201);
            }
            h.clock.advance(61_000); // the per-minute allowance refills
        }
        expect((await ask(DAVE, contest.id, { question: "one too many" })).status).toBe(429);
        h.clock.advance(5 * HOUR);
        await advanceContests(context());
        expect((await ask(CAROL, contest.id, { question: "late" })).status).toBe(409);
    });
});

describe("answering", () => {
    it("is the host staff's, once, to the asker alone or to everyone", async () => {
        const contest = await runningContest();
        const quiet = await asked(DAVE, contest.id, "May I use Python?");
        const loud = await asked(CAROL, contest.id, "Is the input sorted?");
        expect(
            (await answer(DAVE, contest.id, quiet.id, { answer: "yes", public: true })).status,
        ).toBe(404);
        expect(
            (await answer(ALICE, contest.id, quiet.id, { answer: "Yes.", public: false })).status,
        ).toBe(200);
        expect(
            (await answer(ALICE, contest.id, quiet.id, { answer: "Again", public: false })).status,
        ).toBe(409);
        expect((await answer(BOB, contest.id, loud.id, { answer: "x", public: true })).status).toBe(
            404,
        ); // a setter, not owner/admin
        const done = clarificationSchema.parse(
            await (
                await answer(ALICE, contest.id, loud.id, { answer: "Yes, sorted.", public: true })
            ).json(),
        );
        expect(done).toMatchObject({ answer: "Yes, sorted.", public: true });

        const seenByDave = await listFor(DAVE, contest.id);
        expect(seenByDave.map((c) => c.answer).sort()).toEqual(["Yes, sorted.", "Yes."]);
        const seenByStranger = await listFor(null, contest.id);
        expect(seenByStranger.map((c) => c.question)).toEqual(["Is the input sorted?"]); // only the public one
        expect(seenByStranger[0]?.mine).toBe(false);
        const wrongContest = await runningContest();
        expect(
            (await answer(ALICE, wrongContest.id, quiet.id, { answer: "x", public: true })).status,
        ).toBe(404);
        expect(
            (await answer(ALICE, contest.id, loud.id, { answer: "", public: true })).status,
        ).toBe(400);
        expect((await answer(ALICE, contest.id, loud.id, { answer: "x" })).status).toBe(400);
    });

    it("is closed once the contest is finalized", async () => {
        const contest = await runningContest();
        const question = await asked(DAVE, contest.id);
        h.clock.advance(5 * HOUR);
        await advanceContests(context());
        expect((await call(ALICE, "POST", `/contests/${contest.id}/finalize`)).status).toBe(200);
        expect(
            (await answer(ALICE, contest.id, question.id, { answer: "late", public: true })).status,
        ).toBe(409);
    });

    it("cannot be edited or deleted by any role", async () => {
        const contest = await runningContest();
        const question = await asked(DAVE, contest.id);
        const { sql } = h.db.database;
        const refused = (work: Promise<unknown>) =>
            work.then(
                () => "changed",
                (e: Error) => e.message,
            );
        const id = decodeId("clr", question.id);
        expect(
            await refused(
                sql`update contest_clarifications set question = 'edited' where id = ${id}`,
            ),
        ).toMatch(/does not change/);
        expect(await refused(sql`delete from contest_clarifications where id = ${id}`)).toMatch(
            /never deleted/,
        );
    });
});
