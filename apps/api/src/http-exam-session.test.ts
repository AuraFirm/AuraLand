// Goal: a candidate's own sitting through the real HTTP app and PostgreSQL with the injected clock. A rostered
// person joins, consents to the current wording, starts only while the window is open and gets the server's
// deadline (the same on reconnect); the statement is theirs to read only once started; staff do not sit; an
// outsider learns nothing; a sitting past its deadline expires.

import { randomBytes } from "node:crypto";
import {
    consentTextSchema,
    examProblemViewSchema,
    examSchema,
    examSessionSchema,
} from "@aura/contracts/api/exams";
import { encodeId } from "@aura/contracts/ids";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { SPEC } from "./http-task-support.ts";
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
        values (${host}, ${task?.id ?? ""}, 1, 'released', ${sql.json(SPEC)}, 'Read **two** numbers.', 10, ${randomBytes(32)}, ${ALICE}, ${BOB}, now(), true, now()) returning id`;
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
const tick = () => advanceExams(context());

// An exam for CAROL and ERIN (30 minutes extra), published, window 2 h to 6 h from now, one hour long.
async function publishedExam(): Promise<string> {
    const created = await call(ALICE, "POST", `/orgs/${hostPublic}/exams`, {
        title: "Lab",
        mode: "ai_free",
        duration_s: 3600,
        window_start: iso(2 * HOUR),
        window_end: iso(6 * HOUR),
        problems: [
            { label: "A", task_version_id: version, points: 100, auto_percent: 100, rubric: [] },
        ],
    });
    const exam = examSchema.parse(await created.json());
    await call(ALICE, "PUT", `/exams/${exam.id}/roster`, {
        csv: "email,name,extra_minutes\ncarol@example.com,Carol,30\nbob@example.com,Bob,0\n",
    });
    expect((await call(ALICE, "POST", `/exams/${exam.id}/publish`)).status).toBe(200);
    return exam.id;
}
const session = async (user: string, id: string) =>
    examSessionSchema.parse(await (await call(user, "GET", `/exams/${id}/session`)).json());

describe("sitting an exam", () => {
    it("joins, consents to the current wording, starts in the window and keeps the same deadline on reconnect", async () => {
        const exam = await publishedExam();
        const text = consentTextSchema.parse(
            await (await call(null, "GET", "/exam-consent-text")).json(),
        );
        expect(text.version).toBe(1);
        expect(text.text).toContain("It records nothing else");
        const joined = await call(CAROL, "POST", `/exams/${exam}/join`);
        expect(joined.status).toBe(201);
        expect(examSessionSchema.parse(await joined.json())).toMatchObject({
            state: "invited",
            extra_minutes: 30,
            consented: false,
        });
        expect((await call(CAROL, "POST", `/exams/${exam}/start`)).status).toBe(409); // consent first
        expect(
            (await call(CAROL, "POST", `/exams/${exam}/consent`, { text_version: 2 })).status,
        ).toBe(409); // not the wording shown
        expect(
            (await call(CAROL, "POST", `/exams/${exam}/consent`, { text_version: 1 })).status,
        ).toBe(200);
        expect((await call(CAROL, "POST", `/exams/${exam}/start`)).status).toBe(409); // the window has not opened
        h.clock.advance(2 * HOUR + 60_000);
        await tick();
        const started = examSessionSchema.parse(
            await (await call(CAROL, "POST", `/exams/${exam}/start`)).json(),
        );
        expect(started.state).toBe("started");
        // One hour plus 30 minutes of accommodation, from the moment the server started it.
        expect(Date.parse(started.deadline_at ?? "") - Date.parse(started.started_at ?? "")).toBe(
            90 * 60_000,
        );
        h.clock.advance(20 * 60_000);
        const again = examSessionSchema.parse(
            await (await call(CAROL, "POST", `/exams/${exam}/start`)).json(),
        );
        expect(again.deadline_at).toBe(started.deadline_at);
        expect((await session(CAROL, exam)).state).toBe("started");
    });

    it("shows the statement only once started, as an allowlist, and nothing to an outsider", async () => {
        const exam = await publishedExam();
        await call(CAROL, "POST", `/exams/${exam}/join`);
        await call(CAROL, "POST", `/exams/${exam}/consent`, { text_version: 1 });
        expect((await call(CAROL, "GET", `/exams/${exam}/problems/A`)).status).toBe(404); // not started
        h.clock.advance(2 * HOUR + 60_000);
        await tick();
        await call(CAROL, "POST", `/exams/${exam}/start`);
        const view = await call(CAROL, "GET", `/exams/${exam}/problems/A`);
        expect(view.status).toBe(200);
        const problem = examProblemViewSchema.parse(await view.json());
        expect(problem).toMatchObject({ label: "A", title: "Sum of two numbers" });
        expect(problem.statement_html).toContain("<strong>two</strong>");
        expect((await call(DAVE, "GET", `/exams/${exam}/problems/A`)).status).toBe(404);
        expect((await call(DAVE, "POST", `/exams/${exam}/join`)).status).toBe(404);
        expect((await call(DAVE, "GET", `/exams/${exam}/session`)).status).toBe(404);
        expect((await call(null, "POST", `/exams/${exam}/join`)).status).toBe(401);
    });
});

describe("staff and the deadline", () => {
    it("does not let staff sit their own exam, and expires a sitting at its deadline", async () => {
        const exam = await publishedExam();
        expect((await call(ALICE, "POST", `/exams/${exam}/join`)).status).toBe(404); // not on the roster
        await call(ALICE, "PUT", `/exams/${exam}/roster`, {
            csv: "email,name\nalice@example.com,Alice\ncarol@example.com,Carol\n",
        });
        expect((await call(ALICE, "POST", `/exams/${exam}/join`)).status).toBe(403);
        await call(CAROL, "POST", `/exams/${exam}/join`);
        await call(CAROL, "POST", `/exams/${exam}/consent`, { text_version: 1 });
        h.clock.advance(2 * HOUR + 60_000);
        await tick();
        await call(CAROL, "POST", `/exams/${exam}/start`);
        h.clock.advance(61 * 60_000);
        await tick();
        expect((await session(CAROL, exam)).state).toBe("expired");
        h.clock.advance(HOUR);
        expect((await call(CAROL, "POST", `/exams/${exam}/start`)).status).toBe(409); // an expired sitting does not start again
        expect((await session(CAROL, exam)).state).toBe("expired");
    });
});
