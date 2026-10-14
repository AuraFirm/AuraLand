// Goal: the scoreboard tick against real PostgreSQL. Judged contest submissions become a stored board;
// an untouched contest is not rebuilt or rewritten; a change (a verdict, a rejudge) bumps the version once;
// the public board stops at the freeze while the final one does not; only public profiles are named, and
// no user id is ever stored.

import { randomBytes } from "node:crypto";
import { contestSchema } from "@aura/contracts/api/contests";
import { scoreboardBodySchema } from "@aura/contracts/api/scoreboard";
import { submissionSchema } from "@aura/contracts/api/submissions";
import { decodeId, encodeId } from "@aura/contracts/ids";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import {
    createPostgresScoreboardPort,
    refreshScoreboards,
} from "./modules/contests/scoreboard-tick.ts";
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
const tick = () => refreshScoreboards(createPostgresScoreboardPort(context()), h.clock);

const runningContest = async (over: Record<string, unknown> = {}) => {
    const contest = await published(over);
    h.clock.advance(2 * HOUR + 1000);
    await advanceContests(context());
    for (const user of [DAVE, CAROL]) {
        expect((await call(user, "POST", `/contests/${contest.id}/registrations`)).status).toBe(
            201,
        );
    }
    return contest;
};
const submit = async (user: string, contest: string) => {
    const response = await call(user, "POST", `/contests/${contest}/problems/A/submissions`, {
        language: "cpp",
        source: "int main(){}",
    });
    expect(response.status).toBe(201);
    return decodeId("sub", submissionSchema.parse(await response.json()).id);
};
const judge = async (submission: string, verdict: string, score: number | null = null) => {
    const { sql } = h.db.database;
    await sql`update submissions set state = 'judging', updated_at = now() where id = ${submission}`;
    await sql`update submissions set state = 'judged', verdict = ${verdict}, score = ${score}, judged_at = now(), updated_at = now() where id = ${submission}`;
};
const stored = async (contest: string, view: string) => {
    const [row] = await h.db.database.sql<{ version: number; etag: string; body: unknown }[]>`
        select version, etag, body from contest_scoreboards
         where contest_id = ${decodeId("cst", contest)} and view = ${view}`;
    return row === undefined ? null : { ...row, body: scoreboardBodySchema.parse(row.body) };
};

const rewrite = async (submission: string, verdict: string) => {
    // A rejudge arrives in slice 7; until then the guard is lifted here to stand in for it.
    const { sql } = h.db.database;
    await sql`alter table submissions disable trigger submissions_guard`;
    await sql`update submissions set verdict = ${verdict}, updated_at = now() where id = ${submission}`;
    await sql`alter table submissions enable trigger submissions_guard`;
};

describe("the scoreboard tick", () => {
    it("builds a board for a live contest, rebuilds it only when something changed", async () => {
        const contest = await runningContest();
        await tick();
        const empty = await stored(contest.id, "public");
        expect(empty?.version).toBe(1);
        expect(empty?.body.rows.map((r) => r.solved)).toEqual([0, 0]);

        const sub = await submit(DAVE, contest.id);
        await tick(); // queued, not judged: no change to the board
        expect((await stored(contest.id, "public"))?.version).toBe(1);

        await judge(sub, "AC");
        await tick();
        const solved = await stored(contest.id, "public");
        expect(solved?.version).toBe(2);
        expect(solved?.body.rows[0]).toMatchObject({ rank: 1, solved: 1, penalty_minutes: 0 });

        await tick();
        await tick();
        expect((await stored(contest.id, "public"))?.version).toBe(2); // nothing happened: nothing written

        await rewrite(sub, "WA");
        await tick();
        const rejudged = await stored(contest.id, "public");
        expect(rejudged?.version).toBe(3);
        expect(rejudged?.body.rows.every((r) => r.solved === 0)).toBe(true);
        expect(rejudged?.body.rows.flatMap((r) => r.cells.map((c) => c.attempts))).toContain(1);
        expect(rejudged?.etag).not.toBe(solved?.etag);
    });

    it("stops the public board at the freeze and names only public profiles; no user id is stored", async () => {
        const { sql } = h.db.database;
        await sql`insert into profiles (user_id, handle, display_name, visibility) values
            (${DAVE}, 'dave_d', 'Dave D', 'public'), (${CAROL}, 'carol_c', 'Carol C', 'unlisted')
            on conflict (user_id) do update set visibility = excluded.visibility`;
        const contest = await runningContest();
        h.clock.advance(4 * HOUR); // past the freeze at 6 h
        await advanceContests(context());
        const sub = await submit(DAVE, contest.id);
        await judge(sub, "AC");
        await tick();
        const publicView = await stored(contest.id, "public");
        const finalView = await stored(contest.id, "final");
        expect(publicView?.body.frozen).toBe(true);
        expect(publicView?.body.rows.map((r) => r.solved)).toEqual([0, 0]);
        expect(publicView?.body.rows.flatMap((r) => r.cells.map((c) => c.hidden))).toContain(1);
        expect(finalView?.body.rows[0]).toMatchObject({ solved: 1, handle: "dave_d" });
        const named = finalView?.body.rows.map((r) => [r.participant, r.handle, r.display_name]);
        // Both registered at the same injected instant, so registration order falls back to the user id.
        expect(named).toContainEqual([2, "dave_d", "Dave D"]);
        expect(named).toContainEqual([1, null, null]); // carol is unlisted
        const text = JSON.stringify([publicView?.body, finalView?.body]);
        for (const id of [DAVE, CAROL]) expect(text).not.toContain(id);
    });

    it("does not build a board for a contest that has not started", async () => {
        const contest = await published();
        expect(await tick()).toBeGreaterThanOrEqual(0);
        expect(await stored(contest.id, "public")).toBeNull();
    });
});
