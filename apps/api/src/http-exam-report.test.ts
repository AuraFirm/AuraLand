// Goal: the exam summary and the draft attainment report through the real HTTP app and PostgreSQL: counts for the
// institution, a CSV with one row per problem, both for the host's staff only.

import { randomBytes } from "node:crypto";
import { examSchema, examSummarySchema } from "@aura/contracts/api/exams";
import { decodeId, encodeId } from "@aura/contracts/ids";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { SPEC } from "./http-task-support.ts";
import { advanceExams } from "./modules/exams/tick.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3"; // plain member of the host
const DAVE = "018f0000-0000-7000-8000-0000000000d4"; // a stranger
const EVE = "018f0000-0000-7000-8000-0000000000e5"; // sits the exam
const ERIN = "018f0000-0000-7000-8000-0000000000a7"; // a second admin of the host
const FRANK = "018f0000-0000-7000-8000-0000000000f6"; // sits the exam
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
        [EVE, "eve"],
        [FRANK, "frank"],
        [ERIN, "erin"],
    ] as const) {
        await sql`insert into users (id, email, email_verified_at) values (${id}, ${`${name}@example.com`}, now())`;
    }
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'http-uni', 'Uni') returning id`;
    host = org?.id ?? "";
    hostPublic = encodeId("org", host);
    await sql`insert into memberships (org_id, user_id, role) values
        (${host}, ${ALICE}, 'owner'), (${host}, ${BOB}, 'setter'), (${host}, ${CAROL}, 'member'), (${host}, ${ERIN}, 'admin')`;
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

const SOURCE = "int main() { return 0; }";

async function finishedExam(): Promise<{ exam: string; session: string }> {
    // Requests left waiting by an earlier test would be taken by this test's worker too.
    await h.db.database
        .sql`update oral_defences set state = 'failed' where state in ('pending', 'generating')`;
    const created = await call(ALICE, "POST", `/orgs/${hostPublic}/exams`, {
        title: "Oral lab",
        mode: "ai_free",
        duration_s: 3600,
        window_start: iso(2 * HOUR),
        window_end: iso(6 * HOUR),
        problems: [
            { label: "A", task_version_id: version, points: 100, auto_percent: 100, rubric: [] },
        ],
    });
    const exam = examSchema.parse(await created.json()).id;
    await call(ALICE, "PUT", `/exams/${exam}/roster`, {
        csv: "email,name\ncarol@example.com,Carol\n",
    });
    await call(ALICE, "POST", `/exams/${exam}/publish`);
    await call(CAROL, "POST", `/exams/${exam}/join`);
    await call(CAROL, "POST", `/exams/${exam}/consent`, { text_version: 1 });
    h.clock.advance(2 * HOUR + 60_000);
    await tick();
    await call(CAROL, "POST", `/exams/${exam}/start`);
    await call(CAROL, "PUT", `/exams/${exam}/problems/A/draft`, {
        seq: 1,
        language: "cpp",
        content: SOURCE,
    });
    await call(CAROL, "POST", `/exams/${exam}/submit`);
    await tick();
    const [row] = await h.db.database.sql<
        { id: string }[]
    >`select id from exam_sessions where exam_id = ${decodeId("exm", exam)}`;
    return { exam, session: encodeId("exs", row?.id ?? "") };
}

describe("summary and report", () => {
    it("counts where the exam stands and reports attainment per problem, for staff only", async () => {
        const { exam } = await finishedExam();
        const summary = examSummarySchema.parse(
            await (await call(ALICE, "GET", `/exams/${exam}/summary`)).json(),
        );
        expect(summary).toEqual({
            joined: 1,
            consented: 1,
            started: 0,
            submitted: 1,
            expired: 0,
            flags_open: 0,
            appeals_open: 0,
            oral_waiting: 0,
        });
        const csv = await (await call(ALICE, "GET", `/exams/${exam}/report.csv`)).text();
        const [header, line] = csv.split("\r\n");
        expect(header).toBe(
            "problem,points,candidates,answered,mean_percent,attained,attained_percent",
        );
        expect(line).toBe("A,100,1,1,0,0,0"); // not judged yet: nothing earned
        for (const path of ["summary", "report.csv"]) {
            for (const user of [CAROL, DAVE, BOB])
                expect(
                    (await call(user, "GET", `/exams/${exam}/${path}`)).status,
                    `${path} ${user}`,
                ).toBe(404);
            expect((await call(null, "GET", `/exams/${exam}/${path}`)).status).toBe(401);
        }
    });
});
