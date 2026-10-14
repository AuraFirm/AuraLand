// Goal: contest submissions obey the window, the registration, the rules and the queue, in the database,
// with the clock the caller supplies; per-test results stay hidden until the contest ends; practice
// cannot be used to walk around any of it. Setup runs as the database owner; behaviour under test runs as
// the application roles with real request contexts.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const U = (n: number) => `018f0000-0000-7000-8000-00000000060${n}`;
const OWNER = U(1);
const MEMBER = U(2); // a plain member of the host organization
const STUDENT = U(3);
const OTHER = U(4);
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const WORKER: RequestContext = { actorKind: "worker", userId: null, orgIds: [] };
const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);
const at = (hours: number, minutes = 0) => new Date(Date.UTC(2026, 10, 1, 10 + hours, minutes));
const START = at(0);
const END = at(5);
const DURING = at(1);

let db: TestDatabase;
let host = "";
let version = "";
let contest = "";
beforeAll(async () => {
    db = await createMigratedTestDatabase(10);
    const { sql } = db.database;
    for (const n of [1, 2, 3, 4])
        await sql`insert into users (id, email) values (${U(n)}, ${`s${n}@example.com`})`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'sub-uni', 'U') returning id`;
    host = org?.id ?? "";
    await sql`insert into memberships (org_id, user_id, role) values (${host}, ${OWNER}, 'owner'), (${host}, ${MEMBER}, 'member')`;
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${host}, 'sub-task', 'algorithmic', 'org', 'T', ${OWNER}) returning id`;
    await sql`alter table task_versions disable trigger task_versions_guard`;
    const [v] = await sql<{ id: string }[]>`insert into task_versions
        (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
        values (${host}, ${task?.id ?? ""}, 1, 'released', ${sql.json({ spec_version: 1 })}, 'Add.', 10, ${randomBytes(32)}, ${OWNER}, ${OTHER}, now(), true, now()) returning id`;
    await sql`alter table task_versions enable trigger task_versions_guard`;
    version = v?.id ?? "";
    const [c] = await sql<
        { id: string }[]
    >`insert into contests (org_id, slug, title, format, rules, starts_at, ends_at, freeze_at, created_by)
        values (${host}, 'sub-contest', 'C', 'icpc', ${sql.json({ format: "icpc", submit_interval_s: 10, languages: ["cpp", "python3"] })},
                ${START}, ${END}, ${at(4)}, ${OWNER}) returning id`;
    contest = c?.id ?? "";
    await sql`insert into contest_problems (contest_id, org_id, label, task_version_id, task_org_id) values (${contest}, ${host}, 'A', ${version}, ${host})`;
    await sql`update contests set state = 'scheduled' where id = ${contest}`;
    await sql`insert into registrations (contest_id, user_id, created_at) values (${contest}, ${STUDENT}, ${at(-1)}), (${contest}, ${MEMBER}, ${at(-1)})`;
});
afterAll(async () => {
    await db.drop();
});

const countResults = async (userId: string, submissionId: string) =>
    (
        await inRole(
            db.database,
            "aura_app",
            as(userId),
            (tx) => tx`select test_id from verdict_details where submission_id = ${submissionId}`,
        )
    ).length;
const countSubmissions = async (userId: string) =>
    (
        await inRole(
            db.database,
            "aura_app",
            as(userId),
            (tx) => tx`select id from submissions where context_id = ${contest}`,
        )
    ).length;
const advance = (now: Date) =>
    inRole(db.database, "aura_worker", WORKER, (tx) => tx`select * from advance_contests(${now})`);
const submit = (
    userId: string,
    now: Date,
    over: { label?: string; language?: string; source?: string; ready?: number } = {},
) =>
    inRole(
        db.database,
        "aura_app",
        as(userId),
        (tx) =>
            tx<
                { id: string }[]
            >`select create_contest_submission(${contest}, ${over.label ?? "A"}, ${over.language ?? "cpp"},
            ${over.source ?? "int main(){}"}, ${now}, ${over.ready ?? 10_000}) as id`,
    ).then((rows) => rows[0]?.id ?? "");

describe("create_contest_submission", () => {
    it("is refused until the contest runs, then creates a queued contest submission and a priority-1 job", async () => {
        await fails(submit(STUDENT, at(-1)), /not accepting submissions/); // scheduled
        await advance(DURING);
        const id = await submit(STUDENT, DURING);
        const [row] = await db.database.sql<
            { context_kind: string; context_id: string; org_id: string; state: string }[]
        >`
            select context_kind, context_id, org_id, state from submissions where id = ${id}`;
        expect(row).toMatchObject({
            context_kind: "contest",
            context_id: contest,
            org_id: host,
            state: "queued",
        });
        const [job] = await db.database.sql<
            { priority: number; queue: string }[]
        >`select priority, queue from jobs where payload->>'submission_id' = ${id}`;
        expect(job).toMatchObject({ priority: 1, queue: "judge" });
    });

    it("needs registration, a known problem, an allowed language and a reasonable source", async () => {
        await advance(DURING);
        await fails(submit(OTHER, DURING), /no such contest for you/);
        await fails(submit(STUDENT, at(1, 5), { label: "Z" }), /no such problem/);
        await fails(submit(STUDENT, at(1, 5), { language: "java" }), /language is not allowed/);
        await fails(submit(STUDENT, at(1, 5), { source: "" }), /1 byte to 256 KiB/);
        await fails(submit(STUDENT, at(1, 5), { source: "x".repeat(262145) }), /1 byte to 256 KiB/);
        await fails(
            inRole(
                db.database,
                "aura_app",
                { actorKind: "anonymous", userId: null, orgIds: [] },
                (tx) =>
                    tx`select create_contest_submission(${contest}, 'A', 'cpp', 'x', ${DURING}, 10)`,
            ),
            /sign in/,
        );
    });

    it("enforces the interval per problem and tells how long to wait, then lets the next one in", async () => {
        const first = at(2);
        await submit(MEMBER, first);
        const error = await submit(MEMBER, new Date(first.getTime() + 4_000)).catch(
            (e: unknown) => e,
        );
        expect(String(error)).toMatch(/too soon/);
        expect(error).toMatchObject({ code: "54000", hint: "6" });
        await submit(MEMBER, new Date(first.getTime() + 10_000));
    });

    it("closes at the end by the clock it is given, even when the state still says running", async () => {
        await advance(DURING);
        await fails(submit(STUDENT, END), /not accepting submissions/); // state may still be running: the time decides
        const state = await db.database.sql<
            { state: string }[]
        >`select state from contests where id = ${contest}`;
        expect(["running", "frozen"]).toContain(state[0]?.state);
    });

    it("sheds when the queue is full", async () => {
        await advance(DURING);
        await fails(submit(STUDENT, at(3), { ready: 0 }), /queue is full/);
    });
});

describe("the other doors", () => {
    it("gives the app role no way to insert a contest submission directly", async () => {
        const insert = () =>
            inRole(
                db.database,
                "aura_app",
                as(MEMBER),
                (
                    tx,
                ) => tx`insert into submissions (org_id, user_id, task_version_id, language, source, source_sha256, source_bytes, created_at, updated_at, context_kind, context_id)
                    values (${host}, ${MEMBER}, ${version}, 'cpp', 'x', ${Buffer.alloc(32)}, 1, now(), now(), 'contest', ${contest})`,
            );
        await fails(insert(), /permission denied/);
    });

    it("refuses practice submissions to a problem of a contest that has not ended, for anyone who can read it", async () => {
        await advance(DURING);
        const practice = () =>
            inRole(
                db.database,
                "aura_app",
                as(MEMBER),
                (tx) =>
                    tx`insert into submissions (org_id, user_id, task_version_id, language, source, source_sha256, source_bytes, created_at, updated_at)
                values (${host}, ${MEMBER}, ${version}, 'cpp', 'x', ${randomBytes(32)}, 1, now(), now())`,
            );
        await fails(practice(), /belongs to a contest that has not ended/);
        await advance(at(6));
        await practice(); // once the contest has ended, practice is open again
    });
});

describe("what a contestant can read of the results", () => {
    it("hides per-test results while the contest lasts and opens them when it ends; others never read them", async () => {
        // Its own contest, so what the other tests did to the clock cannot make this one vacuous.
        const { sql } = db.database;
        const [c] = await sql<
            { id: string }[]
        >`insert into contests (org_id, slug, title, format, rules, starts_at, ends_at, created_by)
            values (${host}, 'hidden-results', 'H', 'ioi', ${sql.json({ format: "ioi", submit_interval_s: 0, languages: ["cpp"] })},
                    ${at(100)}, ${at(105)}, ${OWNER}) returning id`;
        const own = c?.id ?? "";
        await sql`insert into contest_problems (contest_id, org_id, label, task_version_id, task_org_id) values (${own}, ${host}, 'A', ${version}, ${host})`;
        await sql`update contests set state = 'scheduled' where id = ${own}`;
        await sql`insert into registrations (contest_id, user_id, created_at) values (${own}, ${STUDENT}, ${at(99)})`;
        await advance(at(101));
        const [sub] = await inRole(
            db.database,
            "aura_app",
            as(STUDENT),
            (tx) =>
                tx<
                    { id: string }[]
                >`select create_contest_submission(${own}, 'A', 'cpp', 'int main(){}', ${at(101)}, 10000) as id`,
        );
        const id = sub?.id ?? "";
        await sql`insert into verdict_details (submission_id, org_id, test_id, verdict, cpu_ms, wall_ms, memory_kib)
            values (${id}, ${host}, '001', 'WA', 5, 6, 100)`;
        expect(await countResults(STUDENT, id)).toBe(0); // running: the verdict may show, the tests may not
        expect(await countResults(OTHER, id)).toBe(0);
        await advance(at(106));
        expect(await countResults(STUDENT, id)).toBe(1); // ended: their own results open
        expect(await countResults(OTHER, id)).toBe(0); // somebody else's stay theirs
    });

    it("lets the host's owner read the contest's submissions and nobody else read another person's", async () => {
        const submissions = countSubmissions;
        expect(await submissions(OWNER)).toBeGreaterThan(0);
        expect(await submissions(OTHER)).toBe(0);
        const mine = await submissions(STUDENT);
        const all = await submissions(OWNER);
        expect(mine).toBeLessThan(all); // the student sees only their own, the organizer sees every one
    });
});
