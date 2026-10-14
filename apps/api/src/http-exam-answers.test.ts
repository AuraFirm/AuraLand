// Goal: handing in and judging an exam through the real HTTP app and PostgreSQL. A candidate hands in early (or
// the clock ends the sitting); the worker queues each problem's final draft for judging at a priority between
// contests and practice; a candidate cannot see the verdict or per-test results of their exam submissions until
// the grades are released, the host's staff can at any time, and nobody else can; nothing is queued twice.

import { randomBytes } from "node:crypto";
import { examSchema, examSessionSchema } from "@aura/contracts/api/exams";
import { submissionSchema } from "@aura/contracts/api/submissions";
import { decodeId, encodeId } from "@aura/contracts/ids";
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
const save = (user: string | null, exam: string, body: Record<string, unknown>, label = "A") =>
    call(user, "PUT", `/exams/${exam}/problems/${label}/draft`, body);
async function startedExam(): Promise<{ exam: string; deadline: number }> {
    const exam = await publishedExam();
    await call(CAROL, "POST", `/exams/${exam}/join`);
    await call(CAROL, "POST", `/exams/${exam}/consent`, { text_version: 1 });
    h.clock.advance(2 * HOUR + 60_000);
    await tick();
    const started = examSessionSchema.parse(
        await (await call(CAROL, "POST", `/exams/${exam}/start`)).json(),
    );
    return { exam, deadline: Date.parse(started.deadline_at ?? "") };
}

const submitExam = (user: string, exam: string) => call(user, "POST", `/exams/${exam}/submit`);

describe("handing in and judging", () => {
    it("queues the final draft of each problem once, at priority 2, after the sitting is over", async () => {
        const { exam } = await startedExam();
        await save(CAROL, exam, { seq: 1, language: "cpp", content: "first" });
        await save(CAROL, exam, { seq: 2, language: "cpp", content: "final answer" });
        const handedIn = examSessionSchema.parse(await (await submitExam(CAROL, exam)).json());
        expect(handedIn.state).toBe("submitted");
        expect((await submitExam(CAROL, exam)).status).toBe(200); // handing in twice is the same
        expect(
            (await save(CAROL, exam, { seq: 3, language: "cpp", content: "after" })).status,
        ).toBe(409);
        await tick();
        await tick(); // nothing is queued twice
        const examUuid = decodeId("exm", exam);
        const rows = await h.db.database.sql<
            { source: string; context_kind: string; priority: number }[]
        >`
            select s.source, s.context_kind, j.priority from submissions s
              join jobs j on j.payload ->> 'submission_id' = s.id::text
             where s.context_id = ${examUuid}`;
        expect(rows).toEqual([{ source: "final answer", context_kind: "exam", priority: 2 }]);
    });

    it("hides the verdict and per-test results from the candidate until release, and from everyone else", async () => {
        const { exam } = await startedExam();
        await save(CAROL, exam, { seq: 1, language: "cpp", content: "int main(){}" });
        await submitExam(CAROL, exam);
        await tick();
        const { sql } = h.db.database;
        const examUuid = decodeId("exm", exam);
        const [sub] = await sql<
            { id: string; org_id: string }[]
        >`select id, org_id from submissions where context_id = ${examUuid}`;
        const id = sub?.id ?? "";
        await sql`update submissions set state = 'judging', updated_at = now() where id = ${id}`;
        await sql`update submissions set state = 'judged', verdict = 'AC', score = 100, judged_at = now(), updated_at = now() where id = ${id}`;
        await sql`insert into verdict_details (submission_id, org_id, test_id, verdict, cpu_ms, wall_ms, memory_kib) values (${id}, ${sub?.org_id ?? ""}, '001', 'AC', 1, 1, 1)`;
        const publicId = encodeId("sub", id);
        expect((await call(CAROL, "GET", `/submissions/${publicId}`)).status).toBe(404); // not yet
        expect((await call(DAVE, "GET", `/submissions/${publicId}`)).status).toBe(404);
        const asStaff = await call(ALICE, "GET", `/submissions/${publicId}`);
        expect(asStaff.status).toBe(200);
        expect(submissionSchema.parse(await asStaff.json()).verdict).toBe("AC");
        h.clock.advance(7 * HOUR);
        await tick();
        expect((await call(ALICE, "POST", `/exams/${exam}/release-grades`)).status).toBe(200);
        const own = await call(CAROL, "GET", `/submissions/${publicId}`);
        expect(own.status).toBe(200);
        expect(submissionSchema.parse(await own.json()).tests).toHaveLength(1);
        expect((await call(DAVE, "GET", `/submissions/${publicId}`)).status).toBe(404);
    });

    it("lets the clock end a sitting that was never handed in, and judges what was saved", async () => {
        const { exam, deadline } = await startedExam();
        await save(CAROL, exam, { seq: 1, language: "cpp", content: "saved but never handed in" });
        h.clock.advance(deadline - h.clock.nowUnixMs() + 1000);
        await tick();
        expect((await submitExam(CAROL, exam)).status).toBe(409); // too late to hand in; it simply expired
        const rows = await h.db.database.sql<
            { source: string }[]
        >`select source from submissions where context_id = ${decodeId("exm", exam)}`;
        expect(rows.map((r) => r.source)).toEqual(["saved but never handed in"]);
    });
});
