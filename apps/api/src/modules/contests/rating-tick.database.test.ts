// Goal: the rating job against real PostgreSQL. A finalized, rated contest is rated once, oldest first, only
// for people who submitted; a small contest is skipped and recorded; a person's second contest builds on the
// first; the history never changes; and the database refuses a run that is out of turn.

import { randomBytes } from "node:crypto";
import { withRequestContext } from "@aura/db/context";
import { createMigratedTestDatabase, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeClock } from "../../sim/world.ts";
import { rateNextContest } from "./rating-tick.ts";

const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;
const U = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const MINUTE = 60_000;
const BASE = Date.UTC(2026, 9, 1);
let db: TestDatabase;
let host = "";
let version = "";
const clock = createFakeClock(BASE + 100 * 24 * 60 * MINUTE);
const context = () => ({
    clock,
    inTransaction: <T>(work: Parameters<typeof withRequestContext<T>>[2]) =>
        withRequestContext(db.database.sql, WORKER, work),
});

beforeAll(async () => {
    db = await createMigratedTestDatabase(4);
    const { sql } = db.database;
    for (let n = 1; n <= 60; n++) {
        await sql`insert into users (id, email) values (${U(n)}, ${`r${n}@example.com`})`;
    }
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'rate-uni', 'R') returning id`;
    host = org?.id ?? "";
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${host}, 'rate-task', 'algorithmic', 'private', 'T', ${U(1)}) returning id`;
    await sql`alter table task_versions disable trigger task_versions_guard`;
    const [v] = await sql<{ id: string }[]>`insert into task_versions
        (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
        values (${host}, ${task?.id ?? ""}, 1, 'released', ${sql.json({ spec_version: 1 })}, 'Add.', 10, ${randomBytes(32)}, ${U(1)}, ${U(2)}, now(), true, now()) returning id`;
    await sql`alter table task_versions enable trigger task_versions_guard`;
    version = v?.id ?? "";
});
afterAll(async () => {
    await db.drop();
});

let counter = 0;
// A finalized contest whose people (user numbers) each solved `solved[i]` of their one problem attempts:
// 1 means an accepted run at minute i+1, 0 a wrong answer. Everyone listed submitted once.
async function finalizedContest(
    people: number[],
    solved: number[],
    rated = true,
    finalizedDay = 0,
) {
    const { sql } = db.database;
    const startsAt = BASE + (counter + 1) * 24 * 60 * MINUTE;
    const [c] = await sql<{ id: string }[]>`insert into contests
        (org_id, slug, title, format, rules, starts_at, ends_at, created_by, rated)
        values (${host}, ${`rate-${++counter}`}, 't', 'icpc', ${sql.json({ format: "icpc" })}, ${new Date(startsAt)},
                ${new Date(startsAt + 300 * MINUTE)}, ${U(1)}, ${rated}) returning id`;
    const id = c?.id ?? "";
    await sql`insert into contest_problems (contest_id, org_id, label, task_version_id, task_org_id) values (${id}, ${host}, 'A', ${version}, ${host})`;
    for (const person of people) {
        await sql`insert into registrations (contest_id, user_id, created_at) values (${id}, ${U(person)}, ${new Date(startsAt - MINUTE)})`;
    }
    for (const [i, person] of people.entries()) {
        const [s] = await sql<{ id: string }[]>`insert into submissions
            (org_id, user_id, task_version_id, context_kind, context_id, language, source, source_sha256, source_bytes, created_at, updated_at)
            values (${host}, ${U(person)}, ${version}, 'contest', ${id}, 'cpp', 'x', ${randomBytes(32)}, 1, ${new Date(startsAt + (i + 1) * MINUTE)}, ${new Date(startsAt + (i + 1) * MINUTE)})
            returning id`;
        await sql`update submissions set state = 'judging' where id = ${s?.id ?? ""}`;
        await sql`update submissions set state = 'judged', verdict = ${solved[i] === 1 ? "AC" : "WA"}, judged_at = now() where id = ${s?.id ?? ""}`;
    }
    for (const state of ["scheduled", "running", "ended"]) {
        await sql`update contests set state = ${state} where id = ${id}`;
    }
    await sql`update contests set state = 'finalized', finalized_at = ${new Date(BASE + finalizedDay * 24 * 60 * MINUTE)} where id = ${id}`;
    return id;
}
const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);
const ratingOf = async (person: number) => {
    const [row] = await db.database.sql<{ mu: number; contests: number }[]>`
        select mu, contests from ratings where user_id = ${U(person)}`;
    return row ?? null;
};

describe("rating a finalized contest", () => {
    it("rates the people who submitted once, and never again", async () => {
        const people = range(1, 24);
        // The first ten solve it, the rest do not: ten at a shared rank, fourteen below.
        const id = await finalizedContest(
            people,
            people.map((_, i) => (i < 10 ? 1 : 0)),
        );
        await db.database
            .sql`insert into registrations (contest_id, user_id, created_at) values (${id}, ${U(40)}, now())`; // watches only
        expect(await rateNextContest(context(), clock)).toBe("rated");
        const winner = await ratingOf(1);
        const loser = await ratingOf(24);
        expect(winner?.mu ?? 0).toBeGreaterThan(1500);
        expect(loser?.mu ?? 9999).toBeLessThan(1500);
        expect(await ratingOf(40)).toBeNull(); // registered, never submitted
        const [events] = await db.database.sql<
            { n: string }[]
        >`select count(*)::text as n from rating_events where contest_id = ${id}`;
        expect(events?.n).toBe("24");
        expect(await rateNextContest(context(), clock)).toBe("none"); // nothing left, and never twice
        const [runs] = await db.database.sql<
            { n: string }[]
        >`select count(*)::text as n from contest_ratings where contest_id = ${id}`;
        expect(runs?.n).toBe("1");
    });

    it("builds a second contest on the first, and rates the older finalized contest first", async () => {
        const people = range(1, 22);
        const newer = await finalizedContest(
            people,
            people.map((_, i) => (i === 21 ? 1 : 0)),
            true,
            50,
        );
        const older = await finalizedContest(
            people,
            people.map((_, i) => (i === 21 ? 1 : 0)),
            true,
            0,
        );
        const before = await ratingOf(22);
        const done = async (contest: string) => {
            const rows = await db.database
                .sql`select 1 from contest_ratings where contest_id = ${contest}`;
            return rows.length === 1;
        };
        expect(await rateNextContest(context(), clock)).toBe("rated");
        expect([await done(older), await done(newer)]).toEqual([true, false]);
        expect(await rateNextContest(context(), clock)).toBe("rated");
        expect(await done(newer)).toBe(true);
        const after = await ratingOf(22);
        expect(after?.contests ?? 0).toBe((before?.contests ?? 0) + 2);
    });
});

describe("contests that are not rated", () => {
    it("skips a contest too small to rate, and an unrated one, and records the first", async () => {
        const small = await finalizedContest(range(30, 34), [1, 0, 0, 0, 0]);
        await finalizedContest(
            range(30, 50),
            range(30, 50).map(() => 1),
            false,
        ); // not a rated contest
        expect(await rateNextContest(context(), clock)).toBe("skipped");
        const [run] = await db.database.sql<
            { status: string; participants: number }[]
        >`select status, participants from contest_ratings where contest_id = ${small}`;
        expect(run).toEqual({ status: "skipped", participants: 0 });
        expect(await ratingOf(30)).toBeNull();
        expect(await rateNextContest(context(), clock)).toBe("none");
    });
});

describe("the database's own rules", () => {
    it("refuses a run out of turn, the history being changed, and a rating for someone who did not take part", async () => {
        const people = range(1, 21);
        const first = await finalizedContest(
            people,
            people.map(() => 0),
            true,
            0,
        );
        const second = await finalizedContest(
            people,
            people.map(() => 0),
            true,
            10,
        );
        const { sql } = db.database;
        const attempt = (work: Promise<unknown>) =>
            work.then(
                () => "ok",
                (e: Error) => e.message,
            );
        type Event = Record<string, string | number>;
        const apply = (contest: string, events: Event[]) =>
            sql.begin(
                (tx) =>
                    tx`select rating_apply(${contest}, 'contest', ${events.length === 0 ? "skipped" : "rated"}, 1, ${tx.json(events)}, now())`,
            );
        expect(await attempt(apply(second, []))).toMatch(/older contest/);
        const stranger = {
            user_id: U(59),
            rank: 1,
            mu_before: 1500,
            mu_after: 1600,
            sigma_after: 300,
            performance: 1700,
        };
        expect(await attempt(apply(first, [stranger]))).toMatch(/took part/);
        expect(await attempt(apply(first, []))).toBe("ok");
        expect(await attempt(apply(first, []))).toMatch(/not waiting/);
        expect(await attempt(sql`update rating_events set mu_after = 0`)).toMatch(/never changes/);
        expect(await attempt(sql`delete from contest_ratings`)).toMatch(/never changes/);
    });
});
