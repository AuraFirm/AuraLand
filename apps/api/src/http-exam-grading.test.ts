// Goal: grading through the real HTTP app and PostgreSQL. The host's staff see every answer with the judge's verdict,
// score a rubric while the exam is closed (whole numbers within each item's maximum, items of this problem only),
// release only when every answer has been judged, and export the grades as CSV that is safe in a spreadsheet; a
// candidate reads their own points only after release; nobody else sees any of it; and grades freeze at release.

import { randomBytes } from "node:crypto";
import {
    examResultSchema,
    examSchema,
    examSessionSchema,
    gradingResponseSchema,
} from "@aura/contracts/api/exams";
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

const submitExam = (user: string, exam: string) => call(user, "POST", `/exams/${exam}/submit`);
const rubric = [{ id: "style", label: "Readable code", max_points: 30 }];

const markJudged = async (id: string) => {
    const { sql } = h.db.database;
    await sql`update submissions set state = 'judging', updated_at = now() where id = ${id}`;
    await sql`update submissions set state = 'judged', verdict = 'AC', score = 100, judged_at = now(), updated_at = now() where id = ${id}`;
};

// An exam with 70% from the judge and 30% from one rubric item; CAROL sits it, hands in and is judged AC (100).
async function gradedSetup(
    judge = true,
): Promise<{ exam: string; session: string; submission: string }> {
    const created = await call(ALICE, "POST", `/orgs/${hostPublic}/exams`, {
        title: "Graded lab",
        mode: "ai_free",
        duration_s: 3600,
        window_start: iso(2 * HOUR),
        window_end: iso(6 * HOUR),
        problems: [{ label: "A", task_version_id: version, points: 100, auto_percent: 70, rubric }],
    });
    const exam = examSchema.parse(await created.json()).id;
    await call(ALICE, "PUT", `/exams/${exam}/roster`, {
        csv: "email,name\ncarol@example.com,\"=cmd|'/c calc'!A1\"\n",
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
        content: "int main(){}",
    });
    const handedIn = await submitExam(CAROL, exam);
    const session = examSessionSchema.parse(await handedIn.json());
    expect(session.state).toBe("submitted");
    await tick();
    const { sql } = h.db.database;
    const [sub] = await sql<
        { id: string }[]
    >`select id from submissions where context_id = ${decodeId("exm", exam)}`;
    if (judge) await markJudged(sub?.id ?? "");
    h.clock.advance(5 * HOUR);
    await tick(); // the window closes
    const [row] = await sql<
        { id: string }[]
    >`select id from exam_sessions where exam_id = ${decodeId("exm", exam)}`;
    return { exam, session: encodeId("exs", row?.id ?? ""), submission: sub?.id ?? "" };
}

describe("grading", () => {
    it("shows staff every answer with the judge's verdict, and scores the rubric within its bounds", async () => {
        const { exam, session } = await gradedSetup();
        const table = gradingResponseSchema.parse(
            await (await call(ALICE, "GET", `/exams/${exam}/grading`)).json(),
        );
        expect(table.rows).toHaveLength(1);
        expect(table.rows[0]).toMatchObject({
            label: "A",
            verdict: "AC",
            judge_score: 100,
            auto_points: 70,
            rubric_points: 0,
            total_points: 70,
        });
        const put = (scores: Record<string, number>, comment = "") =>
            call(ALICE, "PUT", `/exams/${exam}/grades/${session}/A`, {
                rubric_scores: scores,
                comment,
            });
        expect((await put({ style: 31 })).status).toBe(400); // above the item's maximum
        expect((await put({ other: 1 })).status).toBe(400); // not an item of this problem
        expect((await put({ style: -1 })).status).toBe(400);
        expect((await put({ style: 20 }, "Clear, but no tests")).status).toBe(204);
        expect((await put({ style: 25 }, "Better on second look")).status).toBe(204); // re-grading replaces
        const after = gradingResponseSchema.parse(
            await (await call(ALICE, "GET", `/exams/${exam}/grading`)).json(),
        );
        expect(after.rows[0]).toMatchObject({
            rubric_points: 25,
            total_points: 95,
            comment: "Better on second look",
        });
        const detail = await call(ALICE, "GET", `/exams/${exam}/answers/${session}/A`);
        expect(await detail.json()).toMatchObject({ language: "cpp", source: "int main(){}" });
    });
});

describe("who sees grading", () => {
    it("keeps all of it from candidates and strangers until release, then shows the candidate their own result", async () => {
        const { exam, session } = await gradedSetup();
        await call(ALICE, "PUT", `/exams/${exam}/grades/${session}/A`, {
            rubric_scores: { style: 20 },
            comment: "Good",
        });
        for (const path of [
            `/exams/${exam}/grading`,
            `/exams/${exam}/grades.csv`,
            `/exams/${exam}/answers/${session}/A`,
        ]) {
            expect((await call(CAROL, "GET", path)).status, path).toBe(404);
            expect((await call(DAVE, "GET", path)).status, path).toBe(404);
        }
        expect(
            (
                await call(CAROL, "PUT", `/exams/${exam}/grades/${session}/A`, {
                    rubric_scores: { style: 30 },
                })
            ).status,
        ).toBe(404);
        expect((await call(CAROL, "GET", `/exams/${exam}/result`)).status).toBe(404); // not released
        expect((await call(ALICE, "POST", `/exams/${exam}/release-grades`)).status).toBe(200);
        const result = examResultSchema.parse(
            await (await call(CAROL, "GET", `/exams/${exam}/result`)).json(),
        );
        expect(result).toMatchObject({ total_points: 90, max_points: 100 });
        expect(result.problems[0]).toMatchObject({
            auto_points: 70,
            comment: "Good",
            total_points: 90,
        });
        expect(result.problems[0]?.rubric).toEqual([{ ...rubric[0], awarded: 20 }]);
        expect((await call(DAVE, "GET", `/exams/${exam}/result`)).status).toBe(404);
        // Frozen at release.
        expect(
            (
                await call(ALICE, "PUT", `/exams/${exam}/grades/${session}/A`, {
                    rubric_scores: { style: 30 },
                })
            ).status,
        ).toBe(409);
    });

    it("exports the grades as CSV that cannot run as a formula, and waits to release until everything is judged", async () => {
        const { exam } = await gradedSetup();
        const csv = await (await call(ALICE, "GET", `/exams/${exam}/grades.csv`)).text();
        const [header, row] = csv.split("\r\n");
        expect(header).toBe("email,name,status,A,total");
        expect(row).toBe("carol@example.com,'=cmd|'/c calc'!A1,submitted,70,70"); // the name cannot run as a formula
    });

    it("waits to release until every answer is judged", async () => {
        const { exam, submission } = await gradedSetup(false);
        expect((await call(ALICE, "POST", `/exams/${exam}/release-grades`)).status).toBe(409);
        await markJudged(submission);
        expect((await call(ALICE, "POST", `/exams/${exam}/release-grades`)).status).toBe(200);
    });
});
