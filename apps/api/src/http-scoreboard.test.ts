// Goal: the scoreboard tick against real PostgreSQL. Judged contest submissions become a stored board;
// an untouched contest is not rebuilt or rewritten; a change (a verdict, a rejudge) bumps the version once;
// the public board stops at the freeze while the final one does not; only public profiles are named, and
// no user id is ever stored.

import { randomBytes } from "node:crypto";
import { contestSchema } from "@aura/contracts/api/contests";
import { scoreboardBodySchema, scoreboardResponseSchema } from "@aura/contracts/api/scoreboard";
import { submissionSchema } from "@aura/contracts/api/submissions";
import { decodeId, encodeId } from "@aura/contracts/ids";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { icpcScoreboardSchema } from "./modules/contests/scoreboard-export.ts";
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

const read = async (user: string | null, contest: string, query = "") =>
    call(user, "GET", `/contests/${contest}/scoreboard${query}`);

// Reads Server-Sent Events from a response until `count` named events arrived or the stream ended.
async function events(response: Response, count: number, timeoutMs = 5000) {
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("a stream has a body");
    const decoder = new TextDecoder();
    const seen: { event: string; data: string }[] = [];
    let text = "";
    const deadline = Date.now() + timeoutMs;
    while (seen.length < count && Date.now() < deadline) {
        const chunk = await Promise.race([
            reader.read(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
        ]);
        if (chunk === null) continue;
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
        for (const block of text.split("\n\n").slice(0, -1)) {
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (event !== undefined && data !== undefined) seen.push({ event, data });
        }
        text = text.slice(text.lastIndexOf("\n\n") + 2);
    }
    return { seen, text, reader };
}

describe("reading a scoreboard", () => {
    it("answers with a cacheable snapshot, an etag and 304, and hides the final board from outsiders", async () => {
        const contest = await runningContest();
        expect((await read(DAVE, contest.id)).status).toBe(404); // no board before the first tick
        await tick();
        const response = await read(null, contest.id);
        expect(response.status).toBe(200);
        const board = scoreboardResponseSchema.parse(await response.json());
        expect(board.version).toBe(1);
        expect(response.headers.get("etag")).toBe(`"${board.etag}"`);
        expect(response.headers.get("cache-control")).toContain("s-maxage=1");
        const again = await call(null, "GET", `/contests/${contest.id}/scoreboard`);
        expect(again.status).toBe(200);
        const conditional = await h.request(`/contests/${contest.id}/scoreboard`, {
            headers: browser(null, { "if-none-match": `"${board.etag}"` }),
        });
        expect(conditional.status).toBe(304);
        expect((await read(DAVE, contest.id, "?view=final")).status).toBe(404); // not staff
        const staff = await read(ALICE, contest.id, "?view=final");
        expect(staff.status).toBe(200);
        expect(staff.headers.get("cache-control")).toBe("private, no-cache");
        expect((await read(DAVE, contest.id, "?view=other")).status).toBe(400);
        expect((await read(DAVE, "cst_nope")).status).toBe(400);
    });
});

describe("exporting for ICPC tools", () => {
    it("serves the Contest API scoreboard of a stored board with the same caching and privacy", async () => {
        const contest = await runningContest();
        const sub = await submit(DAVE, contest.id);
        await judge(sub, "AC");
        await tick();
        const response = await call(null, "GET", `/contests/${contest.id}/standings.icpc.json`);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toContain("s-maxage=1");
        const out = icpcScoreboardSchema.parse(await response.json());
        expect(out.rows.map((r) => r.score.num_solved)).toEqual([1, 0]);
        expect(out.rows[0]?.problems[0]).toMatchObject({
            problem_id: "A",
            num_judged: 1,
            solved: true,
        });
        expect(
            (await call(DAVE, "GET", `/contests/${contest.id}/standings.icpc.json?view=final`))
                .status,
        ).toBe(404);
        expect(
            (await call(ALICE, "GET", `/contests/${contest.id}/standings.icpc.json?view=final`))
                .status,
        ).toBe(200);
    });
});

describe("watching a scoreboard", () => {
    it("pings a new version when the tick stores one, and not the board itself", async () => {
        const app = h.app();
        const contest = await runningContest();
        await tick();
        const token = (await h.login(DAVE)).token;
        const response = await app.request(`/api/v1/contests/${contest.id}/scoreboard/stream`, {
            headers: browser(token),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        const sub = await submit(DAVE, contest.id);
        const watching = events(response, 2);
        await judge(sub, "AC");
        await tick();
        const { seen, text, reader } = await watching;
        await reader.cancel();
        expect(seen.map((e) => e.event)).toEqual(["version", "version"]);
        expect(JSON.parse(seen[0]?.data ?? "{}")).toMatchObject({ version: 1 });
        expect(JSON.parse(seen[1]?.data ?? "{}")).toMatchObject({ version: 2 });
        expect(text).not.toContain("rows"); // a ping, never a board
    });

    it("refuses what the snapshot refuses and caps the open streams of one person", async () => {
        const app = h.app();
        const contest = await runningContest();
        await tick();
        const token = (await h.login(DAVE)).token;
        const open = () =>
            app.request(`/api/v1/contests/${contest.id}/scoreboard/stream`, {
                headers: browser(token),
            });
        expect(
            (
                await app.request(`/api/v1/contests/${contest.id}/scoreboard/stream?view=final`, {
                    headers: browser(token),
                })
            ).status,
        ).toBe(404);
        const streams: Response[] = [];
        for (let i = 0; i < 5; i++) streams.push(await open());
        expect(streams.map((s) => s.status)).toEqual([200, 200, 200, 200, 200]);
        const sixth = await open();
        expect(sixth.status).toBe(429);
        expect(sixth.headers.get("retry-after")).not.toBeNull();
        await streams[0]?.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const again = await open();
        expect(again.status).toBe(200);
        for (const s of [...streams.slice(1), again]) await s.body?.cancel();
    });
});

describe("a stream's lifetime", () => {
    it("sends keepalives and closes at its lifetime so the client must come back and be checked again", async () => {
        const app = h.app({}, undefined, undefined, { heartbeatMs: 40, lifetimeMs: 250 });
        const contest = await runningContest();
        await tick();
        const response = await app.request(`/api/v1/contests/${contest.id}/scoreboard/stream`, {
            headers: browser((await h.login(DAVE)).token),
        });
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let text = "";
        // unbounded: ends when the server closes the stream, which the test is about
        for (let i = 0; i < 100; i++) {
            const chunk = await reader?.read();
            if (chunk === undefined || chunk.done) break;
            text += decoder.decode(chunk.value);
        }
        expect(text).toContain(": keepalive");
        expect(text.startsWith("retry:") || text.includes("event: version")).toBe(true);
    });
});

const publicBoard = async (contest: string) =>
    scoreboardResponseSchema.parse(await (await read(null, contest)).json());
const post = (user: string, path: string) => call(user, "POST", path);

describe("unfreezing", () => {
    it("lifts the freeze for the public board once, for the host's staff, after the end", async () => {
        const contest = await runningContest();
        h.clock.advance(4 * HOUR); // 6 h in: frozen
        await advanceContests(context());
        await judge(await submit(DAVE, contest.id), "AC");
        await tick();
        const frozen = await publicBoard(contest.id);
        expect(frozen.frozen).toBe(true);
        expect(frozen.rows.map((r) => r.solved)).toEqual([0, 0]);

        expect((await post(ALICE, `/contests/${contest.id}/unfreeze`)).status).toBe(409); // not ended
        h.clock.advance(HOUR);
        await advanceContests(context());
        expect((await post(DAVE, `/contests/${contest.id}/unfreeze`)).status).toBe(403);
        const done = await post(ALICE, `/contests/${contest.id}/unfreeze`);
        expect(done.status).toBe(200);
        expect(contestSchema.parse(await done.json()).unfrozen_at).not.toBeNull();
        expect((await post(ALICE, `/contests/${contest.id}/unfreeze`)).status).toBe(409); // once
        await tick();
        const open = await publicBoard(contest.id);
        expect(open.frozen).toBe(false);
        expect(open.rows.map((r) => r.solved).sort()).toEqual([0, 1]);
        expect(open.version).toBeGreaterThan(frozen.version);
    });

    it("is also done by finalizing, so a finalized board shows everything", async () => {
        const contest = await runningContest();
        h.clock.advance(4 * HOUR);
        await advanceContests(context());
        await judge(await submit(DAVE, contest.id), "AC");
        h.clock.advance(HOUR);
        await advanceContests(context());
        expect((await post(ALICE, `/contests/${contest.id}/finalize`)).status).toBe(200);
        await tick();
        const board = await publicBoard(contest.id);
        expect(board.frozen).toBe(false);
        expect(board.rows.map((r) => r.solved).sort()).toEqual([0, 1]);
    });
});

describe("rejudging", () => {
    it("keeps the old verdict on the board until the new one lands, then replaces it", async () => {
        const contest = await runningContest();
        const sub = await submit(DAVE, contest.id);
        await judge(sub, "AC");
        await tick();
        const before = await publicBoard(contest.id);
        expect(before.rows.map((r) => r.solved).sort()).toEqual([0, 1]);

        const path = `/contests/${contest.id}/submissions/${encodeId("sub", sub)}/rejudge`;
        expect((await post(DAVE, path)).status).toBe(404); // a contestant cannot ask
        expect((await post(CAROL, path)).status).toBe(404);
        const asked = await post(ALICE, path);
        expect(asked.status).toBe(202);
        expect(submissionSchema.parse(await asked.json()).state).toBe("queued");
        expect((await post(ALICE, path)).status).toBe(409); // already waiting
        await tick();
        const during = await publicBoard(contest.id);
        expect(during.etag).toBe(before.etag); // no flicker: the old verdict still counts
        expect(during.version).toBe(before.version);

        await judge(sub, "WA");
        await tick();
        const after = await publicBoard(contest.id);
        expect(after.version).toBe(before.version + 1);
        expect(after.rows.map((r) => r.solved)).toEqual([0, 0]);
    });

    it("refuses a submission of another contest, a finalized contest, and unfinished work", async () => {
        const contest = await runningContest();
        const other = await runningContest();
        const sub = await submit(DAVE, contest.id);
        const wrong = `/contests/${other.id}/submissions/${encodeId("sub", sub)}/rejudge`;
        expect((await post(ALICE, wrong)).status).toBe(404);
        const path = `/contests/${contest.id}/submissions/${encodeId("sub", sub)}/rejudge`;
        expect((await post(ALICE, path)).status).toBe(409); // still queued
        await judge(sub, "AC");
        h.clock.advance(6 * HOUR);
        await advanceContests(context());
        expect((await post(ALICE, `/contests/${contest.id}/finalize`)).status).toBe(200);
        expect((await post(ALICE, path)).status).toBe(409); // ratings come from a finalized board
    });

    it("lets the database refuse every other way of changing a finished submission", async () => {
        const contest = await runningContest();
        const sub = await submit(DAVE, contest.id);
        await judge(sub, "AC");
        const { sql } = h.db.database;
        const attempt = (change: ReturnType<typeof sql>) =>
            change.then(
                () => "changed",
                (e: Error) => e.message,
            );
        expect(
            await attempt(
                sql`update submissions set state = 'queued', verdict = null, score = null, judged_at = null where id = ${sub}`,
            ),
        ).toMatch(/finished submission/);
        expect(
            await attempt(
                sql`update submissions set state = 'queued', verdict = null, score = null, judged_at = null, rejudge_count = 1, previous_verdict = 'WA' where id = ${sub}`,
            ),
        ).toMatch(/finished submission/);
        expect(
            await attempt(sql`update submissions set rejudge_count = 5 where id = ${sub}`),
        ).toMatch(/finished submission/);
    });
});
