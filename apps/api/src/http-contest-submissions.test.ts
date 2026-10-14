// Goal: contest submissions through the real HTTP app and PostgreSQL with the injected clock. Only a
// registered person submits, only while the contest runs, at most one submission per problem per
// interval (with Retry-After), only in an allowed language; the list is the caller's own; nothing leaks
// per-test while it runs.

import { randomBytes } from "node:crypto";
import { contestSchema } from "@aura/contracts/api/contests";
import { submissionSchema, submissionsResponseSchema } from "@aura/contracts/api/submissions";
import { encodeId } from "@aura/contracts/ids";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
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

const runningContest = async () => {
    const contest = await published();
    h.clock.advance(2 * HOUR + 1000);
    await advanceContests(context());
    expect((await call(DAVE, "POST", `/contests/${contest.id}/registrations`)).status).toBe(201);
    return contest;
};
const submit = (user: string, contest: string, body: Record<string, unknown>, label = "A") =>
    call(user, "POST", `/contests/${contest}/problems/${label}/submissions`, body);
const code = { language: "cpp", source: "int main(){}" };

describe("submitting to a contest", () => {
    it("accepts a registered person while it runs and lists only their own", async () => {
        const contest = await runningContest();
        const response = await submit(DAVE, contest.id, code);
        expect(response.status).toBe(201);
        const made = submissionSchema.parse(await response.json());
        expect(made.language).toBe("cpp");
        expect(made.tests ?? []).toEqual([]); // per-test results stay hidden while it runs
        const mine = submissionsResponseSchema.parse(
            await (await call(DAVE, "GET", `/contests/${contest.id}/submissions`)).json(),
        );
        expect(mine.items.map((item) => item.id)).toEqual([made.id]);
        const theirs = submissionsResponseSchema.parse(
            await (await call(CAROL, "GET", `/contests/${contest.id}/submissions`)).json(),
        );
        expect(theirs.items).toEqual([]);
    });

    it("refuses the unregistered, the unknown, bad input and the signed-out", async () => {
        const contest = await runningContest();
        expect((await submit(CAROL, contest.id, code)).status).toBe(404); // not registered
        expect((await submit(DAVE, contest.id, code, "Z")).status).toBe(404); // no such problem
        expect((await submit(DAVE, contest.id, { ...code, language: "cobol" })).status).toBe(400);
        expect((await submit(DAVE, contest.id, { ...code, extra: 1 })).status).toBe(400);
        expect((await submit(DAVE, contest.id, code, "a")).status).toBe(400);
        const out = await h.request(`/contests/${contest.id}/problems/A/submissions`, {
            method: "POST",
            headers: browser(null, { "content-type": "application/json" }),
            body: JSON.stringify(code),
        });
        expect(out.status).toBe(401);
    });

    it("spaces submissions to one problem by the interval and says how long to wait", async () => {
        const contest = await runningContest();
        expect((await submit(DAVE, contest.id, code)).status).toBe(201);
        h.clock.advance(3000);
        const early = await submit(DAVE, contest.id, code);
        expect(early.status).toBe(429);
        const wait = Number(early.headers.get("retry-after"));
        expect(wait).toBeGreaterThan(0);
        expect(wait).toBeLessThanOrEqual(10);
        h.clock.advance(wait * 1000 + 1000);
        expect((await submit(DAVE, contest.id, code)).status).toBe(201);
    });

    it("refuses before the start and after the end", async () => {
        const contest = await published();
        expect((await submit(DAVE, contest.id, code)).status).toBe(404); // not registered yet
        h.clock.advance(2 * HOUR + 1000);
        await advanceContests(context());
        expect((await call(DAVE, "POST", `/contests/${contest.id}/registrations`)).status).toBe(
            201,
        );
        h.clock.advance(5 * HOUR);
        await advanceContests(context());
        expect((await submit(DAVE, contest.id, code)).status).toBe(409);
    });
});
