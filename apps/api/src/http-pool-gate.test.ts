// Goal: the API cannot be wedged by concurrency. A handler holds one pooled connection for its transaction and
// the rate limiter asks for a second one; if as many requests as the pool has connections were inside handlers
// at once, each holding one and waiting for another, nothing could ever move again. The contest load run found
// exactly that. Method: far more concurrent requests than connections, all of which must finish.

import { randomBytes } from "node:crypto";
import { contestSchema } from "@aura/contracts/api/contests";
import { encodeId } from "@aura/contracts/ids";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { SPEC } from "./http-task-support.ts";
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
        values (${host}, ${task?.id ?? ""}, 1, 'released', ${sql.json(SPEC)}, 'Read **two** numbers <script>alert(1)</script> and add them.', 10, ${randomBytes(32)}, ${ALICE}, ${BOB}, now(), true, now()) returning id`;
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
const PEOPLE = 60; // ten times the harness pool

describe("many requests at once", () => {
    it("all finish, though each needs a second connection while it holds its own", async () => {
        const { sql } = h.db.database;
        const contest = await published();
        const people: string[] = [];
        for (let i = 0; i < PEOPLE; i++) {
            const [row] = await sql<
                { id: string }[]
            >`insert into users (email, email_verified_at) values (${`crowd${i}@example.com`}, now()) returning id`;
            people.push(row?.id ?? "");
        }
        const tokens = await Promise.all(people.map(async (id) => (await h.login(id)).token));
        const app = h.app();
        h.clock.advance(3 * HOUR);
        await advanceContests(context());
        const started = performance.now();
        const answers = await Promise.all(
            tokens.map((token) =>
                app.request(`/api/v1/contests/${contest.id}/registrations`, {
                    method: "POST",
                    headers: browser(token),
                }),
            ),
        );
        expect(answers.map((a) => a.status)).toEqual(Array(PEOPLE).fill(201));
        expect(performance.now() - started).toBeLessThan(15_000);
        const [count] = await sql<
            { n: string }[]
        >`select count(*)::text as n from registrations where contest_id = ${contest.id.replace("cst_", "")}`;
        expect(count?.n).toBe(String(PEOPLE));
    });
});
