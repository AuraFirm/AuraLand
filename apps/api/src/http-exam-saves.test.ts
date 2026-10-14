// Goal: autosave through the real HTTP app and PostgreSQL with the injected clock. A started candidate saves full
// snapshots with a rising sequence number; a repeated request is acknowledged again; an old or different one is a
// conflict that names the last number; at the deadline instant nothing is accepted; another candidate's and a
// stranger's saves go nowhere; a new device reads back the latest draft of each problem.

import { randomBytes } from "node:crypto";
import {
    draftSaveResponseSchema,
    draftsResponseSchema,
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

describe("saving", () => {
    it("stores rising snapshots, repeats an acknowledgement, and names the last number on a conflict", async () => {
        const { exam } = await startedExam();
        const first = await save(CAROL, exam, { seq: 1, language: "cpp", content: "int main(){}" });
        expect(first.status).toBe(200);
        expect(draftSaveResponseSchema.parse(await first.json()).acked_seq).toBe(1);
        expect(
            (await save(CAROL, exam, { seq: 1, language: "cpp", content: "int main(){}" })).status,
        ).toBe(200); // a repeat
        const clash = await save(CAROL, exam, { seq: 1, language: "cpp", content: "different" });
        expect(clash.status).toBe(409);
        expect(await clash.text()).toContain("last:1");
        expect(
            (await save(CAROL, exam, { seq: 5, language: "cpp", content: "later" })).status,
        ).toBe(200); // a gap is fine
        expect(
            (await save(CAROL, exam, { seq: 3, language: "cpp", content: "late arrival" })).status,
        ).toBe(409);
        const back = draftsResponseSchema.parse(
            await (await call(CAROL, "GET", `/exams/${exam}/drafts`)).json(),
        );
        expect(back.drafts).toEqual([{ label: "A", seq: 5, language: "cpp", content: "later" }]); // a new device's view
    });

    it("refuses at the deadline instant and after, and not a millisecond before", async () => {
        const { exam, deadline } = await startedExam();
        h.clock.advance(deadline - h.clock.nowUnixMs() - 1);
        expect(
            (await save(CAROL, exam, { seq: 1, language: "cpp", content: "last moment" })).status,
        ).toBe(200);
        h.clock.advance(1);
        const late = await save(CAROL, exam, { seq: 2, language: "cpp", content: "too late" });
        expect(late.status).toBe(409);
        expect(await late.text()).toContain("over");
        const back = draftsResponseSchema.parse(
            await (await call(CAROL, "GET", `/exams/${exam}/drafts`)).json(),
        );
        expect(back.drafts[0]?.content).toBe("last moment"); // the answer is what was acknowledged
    });

    it("refuses strangers, other people's exams, unknown problems, bad bodies and big drafts", async () => {
        const { exam } = await startedExam();
        expect((await save(null, exam, { seq: 1, language: "cpp", content: "x" })).status).toBe(
            401,
        );
        expect((await save(DAVE, exam, { seq: 1, language: "cpp", content: "x" })).status).toBe(
            404,
        );
        expect(
            (await save(CAROL, exam, { seq: 1, language: "cpp", content: "x" }, "Z")).status,
        ).toBe(404);
        expect((await save(CAROL, exam, { seq: 0, language: "cpp", content: "x" })).status).toBe(
            400,
        );
        expect((await save(CAROL, exam, { seq: 1, language: "C++", content: "x" })).status).toBe(
            400,
        );
        expect(
            (await save(CAROL, exam, { seq: 1, language: "cpp", content: "x", extra: 1 })).status,
        ).toBe(400);
        expect(
            (await save(CAROL, exam, { seq: 1, language: "cpp", content: "x".repeat(262_145) }))
                .status,
        ).toBeGreaterThanOrEqual(400); // the body limit or the schema, whichever sees it first
        expect(
            (await save(CAROL, exam, { seq: 1, language: "cpp", content: "a\u0000b" })).status,
        ).toBe(400);
        expect((await call(DAVE, "GET", `/exams/${exam}/drafts`)).status).toBe(404);
    });
});
