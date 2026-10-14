// Goal: the exam rules hold in the database, with the clock the caller supplies. A rostered person gets a
// session, consents once, starts only while the window is open, and gets the deadline the rule says (the
// earlier of start + duration + extra and window end + extra); staff do not sit their own exam; a candidate
// sees only their own session and reads a statement only in their own sitting; the published exam does not
// change. Setup runs as the database owner; behaviour under test runs as the application roles.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const U = (n: number) => `018f0000-0000-7000-8000-00000000070${n}`;
const OWNER = U(1);
const SETTER = U(2);
const ADA = U(3); // on the roster, 30 extra minutes
const BEN = U(4); // on the roster
const CAL = U(5); // not on the roster
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);
const at = (hours: number, minutes = 0) => new Date(Date.UTC(2026, 10, 1, 9 + hours, minutes));
const OPENS = at(0);
const CLOSES = at(4); // a four hour window for a two hour exam

let db: TestDatabase;
let host = "";
let version = "";
let exam = "";

const app = <T>(
    user: string,
    work: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<T>,
) => inRole(db.database, "aura_app", as(user), work);
const worker = <T>(work: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<T>) =>
    inRole(db.database, "aura_worker", { actorKind: "worker", userId: null, orgIds: [] }, work);

async function newExam(
    slug: string,
    over: { duration?: number; close?: Date } = {},
): Promise<string> {
    const { sql } = db.database;
    const [row] = await sql<
        { id: string }[]
    >`insert into exams (org_id, title, mode, duration_s, window_start, window_end, created_by)
        values (${host}, ${slug}, 'ai_free', ${over.duration ?? 7200}, ${OPENS}, ${over.close ?? CLOSES}, ${OWNER}) returning id`;
    const id = row?.id ?? "";
    await app(
        OWNER,
        (tx) =>
            tx`select add_exam_problem(${id}, 'A', ${version}, 100, 70, ${tx.json([{ id: "style", label: "Style", max_points: 30 }])})`,
    );
    await app(
        OWNER,
        (tx) =>
            tx`select set_exam_roster(${id}, ${tx.json([
                { email: "Ada@Example.com", name: "Ada", extra_minutes: 30 },
                { email: "ben@example.com", name: "Ben", extra_minutes: 0 },
            ])})`,
    );
    return id;
}

beforeAll(async () => {
    db = await createMigratedTestDatabase(10);
    const { sql } = db.database;
    const names: [string, string][] = [
        [OWNER, "owner"],
        [SETTER, "setter"],
        [ADA, "ada"],
        [BEN, "ben"],
        [CAL, "cal"],
    ];
    for (const [id, name] of names)
        await sql`insert into users (id, email, email_verified_at) values (${id}, ${`${name}@example.com`}, now())`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'exam-uni', 'U') returning id`;
    host = org?.id ?? "";
    await sql`insert into memberships (org_id, user_id, role) values (${host}, ${OWNER}, 'owner'), (${host}, ${SETTER}, 'setter')`;
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${host}, 'exam-task', 'algorithmic', 'org', 'T', ${OWNER}) returning id`;
    await sql`alter table task_versions disable trigger task_versions_guard`;
    const [v] = await sql<{ id: string }[]>`insert into task_versions
        (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
        values (${host}, ${task?.id ?? ""}, 1, 'released', ${sql.json({ spec_version: 1 })}, 'Add.', 10, ${randomBytes(32)}, ${OWNER}, ${SETTER}, now(), true, now()) returning id`;
    await sql`alter table task_versions enable trigger task_versions_guard`;
    version = v?.id ?? "";
    exam = await newExam("main");
    await app(OWNER, (tx) => tx`select publish_exam(${exam}, ${at(-2)})`);
});
afterAll(async () => {
    await db.drop();
});

describe("setting an exam up", () => {
    it("lets only the host's owners and admins create, change and publish, and freezes it after", async () => {
        const { sql } = db.database;
        await fails(
            app(
                SETTER,
                (
                    tx,
                ) => tx`insert into exams (org_id, title, mode, duration_s, window_start, window_end, created_by)
            values (${host}, 'x', 'ai_free', 600, ${OPENS}, ${CLOSES}, ${SETTER})`,
            ),
            /row-level security/,
        );
        await fails(
            app(SETTER, (tx) => tx`select publish_exam(${exam}, ${at(-2)})`),
            /no such draft exam/,
        );
        const draft = await newExam("freeze-me");
        await app(OWNER, (tx) => tx`select publish_exam(${draft}, ${at(-2)})`);
        await expect(sql`update exams set title = 'other' where id = ${draft}`).rejects.toThrow(
            /does not change/,
        );
        await fails(
            app(
                OWNER,
                (tx) =>
                    tx`select add_exam_problem(${draft}, 'B', ${version}, 100, 100, '[]'::jsonb)`,
            ),
            /do not change/,
        );
    });
});

describe("an exam that cannot be published", () => {
    it("refuses a window shorter than the duration, a rubric that does not add up, and publishing late or empty", async () => {
        const { sql } = db.database;
        await expect(sql`insert into exams (org_id, title, mode, duration_s, window_start, window_end, created_by)
            values (${host}, 'short', 'ai_free', 7200, ${OPENS}, ${at(1, 59)}, ${OWNER})`).rejects.toThrow(
            /exams_window/,
        );
        const [row] = await sql<
            { id: string }[]
        >`insert into exams (org_id, title, mode, duration_s, window_start, window_end, created_by)
            values (${host}, 'empty', 'ai_free', 3600, ${OPENS}, ${CLOSES}, ${OWNER}) returning id`;
        const id = row?.id ?? "";
        await fails(
            app(OWNER, (tx) => tx`select publish_exam(${id}, ${at(-2)})`),
            /at least one problem and one person/,
        );
        await fails(
            app(
                OWNER,
                (tx) =>
                    tx`select add_exam_problem(${id}, 'A', ${version}, 100, 70, ${tx.json([{ id: "a", label: "x", max_points: 29 }])})`,
            ),
            /rubric must carry exactly/,
        );
        await app(
            OWNER,
            (tx) => tx`select add_exam_problem(${id}, 'A', ${version}, 100, 100, '[]'::jsonb)`,
        );
        await app(
            OWNER,
            (tx) =>
                tx`select set_exam_roster(${id}, ${tx.json([{ email: "z@example.com", name: "Z" }])})`,
        );
        await fails(
            app(OWNER, (tx) => tx`select publish_exam(${id}, ${at(0, 1)})`),
            /before its window opens/,
        );
        await app(OWNER, (tx) => tx`select publish_exam(${id}, ${at(-1)})`);
    });
});

describe("sitting an exam", () => {
    it("moves a rostered person from invited to consented to started, with the rule's deadline", async () => {
        await worker((tx) => tx`select * from advance_exams(${at(0, 1)})`);
        const sessionId = await app(
            ADA,
            async (tx) =>
                (await tx<{ id: string }[]>`select join_exam(${exam}, ${at(0, 2)}) as id`)[0]?.id,
        );
        expect(sessionId).toBeTruthy();
        await fails(
            app(ADA, (tx) => tx`select * from start_exam_session(${exam}, ${at(0, 3)})`),
            /consent comes before starting/,
        );
        await app(ADA, (tx) => tx`select consent_exam(${exam}, 1, ${at(0, 3)})`);
        const [started] = await app(
            ADA,
            (tx) =>
                tx<
                    { deadline_at: Date }[]
                >`select deadline_at from start_exam_session(${exam}, ${at(0, 10)})`,
        );
        // 2 hours + 30 extra minutes after 09:10 is 11:40, inside the window's end (13:00) plus the extra.
        expect(started?.deadline_at.toISOString()).toBe(at(2, 40).toISOString());
        const [again] = await app(
            ADA,
            (tx) =>
                tx<
                    { deadline_at: Date }[]
                >`select deadline_at from start_exam_session(${exam}, ${at(1, 30)})`,
        );
        expect(again?.deadline_at.toISOString()).toBe(at(2, 40).toISOString()); // a reconnect keeps the deadline
    });

    it("caps the deadline at the window's end plus the person's extra time", async () => {
        await app(BEN, (tx) => tx`select join_exam(${exam}, ${at(3)})`);
        await app(BEN, (tx) => tx`select consent_exam(${exam}, 1, ${at(3)})`);
        const [late] = await app(
            BEN,
            (tx) =>
                tx<
                    { deadline_at: Date }[]
                >`select deadline_at from start_exam_session(${exam}, ${at(3, 30)})`,
        );
        expect(late?.deadline_at.toISOString()).toBe(CLOSES.toISOString()); // not 11:30 + 2 h
    });
});

describe("who may sit", () => {
    it("refuses people not on the roster, staff, a second consent text, and a start outside the window", async () => {
        await fails(
            app(CAL, (tx) => tx`select join_exam(${exam}, ${at(0, 5)})`),
            /no such exam for you/,
        );
        await fails(
            app(SETTER, (tx) => tx`select join_exam(${exam}, ${at(0, 5)})`),
            /no such exam for you|staff do not sit/,
        );
        const early = await newExam("early");
        await app(OWNER, (tx) => tx`select publish_exam(${early}, ${at(-2)})`);
        await app(BEN, (tx) => tx`select join_exam(${early}, ${at(-1)})`);
        await app(BEN, (tx) => tx`select consent_exam(${early}, 1, ${at(-1)})`);
        await fails(
            app(BEN, (tx) => tx`select * from start_exam_session(${early}, ${at(-1)})`),
            /the exam is not open/,
        );
        await worker((tx) => tx`select * from advance_exams(${at(4, 1)})`);
        await fails(
            app(BEN, (tx) => tx`select * from start_exam_session(${early}, ${at(4, 1)})`),
            /the exam is not open|consent comes before/,
        );
        await expect(
            db.database
                .sql`update exam_sessions set consent_at = now() where exam_id = ${exam} and user_id = ${ADA}`,
        ).rejects.toThrow(/consent is given once/);
    });
});

describe("the clock and visibility", () => {
    it("expires a sitting past its deadline, moves the exam through its states, and keeps the last state", async () => {
        const [state] = await app(
            OWNER,
            (tx) => tx<{ state: string }[]>`select state from exams where id = ${exam}`,
        );
        expect(state?.state).toBe("closed"); // moved by the earlier advance past the window's end
        const expired = await worker(
            (tx) => tx<{ n: number }[]>`select advance_exam_sessions(${at(4, 1)}) as n`,
        );
        expect(expired[0]?.n).toBeGreaterThanOrEqual(1);
        const [ada] = await app(
            ADA,
            (tx) =>
                tx<{ state: string }[]>`select state from exam_sessions where exam_id = ${exam}`,
        );
        expect(ada?.state).toBe("expired");
        await expect(
            db.database
                .sql`update exam_sessions set state = 'started' where exam_id = ${exam} and user_id = ${ADA}`,
        ).rejects.toThrow(/cannot move/);
    });

    it("shows a candidate only their own session, and staff all of them", async () => {
        const mine = await app(
            ADA,
            (tx) =>
                tx<
                    { user_id: string }[]
                >`select user_id from exam_sessions where exam_id = ${exam}`,
        );
        expect(mine.map((r) => r.user_id)).toEqual([ADA]);
        const all = await app(
            OWNER,
            (tx) => tx`select user_id from exam_sessions where exam_id = ${exam}`,
        );
        expect(all.length).toBeGreaterThanOrEqual(2);
        expect(
            await app(CAL, (tx) => tx`select id from exam_sessions where exam_id = ${exam}`),
        ).toHaveLength(0);
        expect(await app(CAL, (tx) => tx`select id from exams where id = ${exam}`)).toHaveLength(0);
        expect(await app(ADA, (tx) => tx`select id from exams where id = ${exam}`)).toHaveLength(1);
        expect(
            await app(ADA, (tx) => tx`select email from exam_roster where exam_id = ${exam}`),
        ).toHaveLength(0); // the roster is staff's
    });

    it("lets a candidate read a statement only once their own sitting has started", async () => {
        const read = (user: string) =>
            app(user, (tx) => tx`select statement from task_versions where id = ${version}`);
        expect(await read(CAL)).toHaveLength(0); // not on the roster
        expect(await read(ADA)).toHaveLength(1); // started, then expired: it stays readable
        const second = await newExam("statement");
        await app(OWNER, (tx) => tx`select publish_exam(${second}, ${at(-2)})`);
        await app(CAL, (tx) => tx`select 1`); // a person who joined nothing
        expect(await read(CAL)).toHaveLength(0);
    });
});
