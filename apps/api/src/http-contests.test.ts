// Goal: contests through the real HTTP app and PostgreSQL. Organizers arrange a draft and publish it; the
// public sees a published contest and, once it starts, its problem labels; strangers register (late too)
// but organizers and problem authors cannot; a published contest cannot be edited; and the clock moves
// contests and leaves an audit trail.

import { randomBytes } from "node:crypto";
import {
    contestSchema,
    contestsResponseSchema,
    registrationResponseSchema,
} from "@aura/contracts/api/contests";
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

describe("creating a contest", () => {
    it("is for the host's owners and admins, as a draft with its problems", async () => {
        const response = await call(ALICE, "POST", `/orgs/${hostPublic}/contests`, request());
        expect(response.status).toBe(201);
        const contest = contestSchema.parse(await response.json());
        expect(contest).toMatchObject({
            state: "draft",
            registered: false,
            can_manage: true,
            rated: false,
            visibility: "public",
        });
        expect(contest.problems).toEqual([{ label: "A", points: 100 }]);
        expect((await call(BOB, "POST", `/orgs/${hostPublic}/contests`, request())).status).toBe(
            403,
        ); // a setter
        expect((await call(DAVE, "POST", `/orgs/${hostPublic}/contests`, request())).status).toBe(
            404,
        ); // not a member
        expect((await call(null, "POST", `/orgs/${hostPublic}/contests`, request())).status).toBe(
            401,
        );
    });

    it("refuses bad windows, duplicate addresses, unknown fields and problems it cannot use", async () => {
        const bad = (over: Record<string, unknown>) =>
            call(ALICE, "POST", `/orgs/${hostPublic}/contests`, request(over));
        expect((await bad({ ends_at: iso(2 * HOUR + 60_000) })).status).toBe(400); // under five minutes
        expect((await bad({ freeze_at: iso(HOUR) })).status).toBe(400); // before the start
        expect((await bad({ rules: { format: "cf_rated" } })).status).toBe(400);
        expect((await bad({ extra: 1 })).status).toBe(400);
        expect(
            (
                await bad({
                    problems: [
                        {
                            label: "A",
                            task_version_id: encodeId(
                                "tsv",
                                "018f0000-0000-7000-8000-0000000000aa",
                            ),
                        },
                    ],
                })
            ).status,
        ).toBe(400);
        const first = request({ slug: "same-address" });
        expect((await call(ALICE, "POST", `/orgs/${hostPublic}/contests`, first)).status).toBe(201);
        expect((await call(ALICE, "POST", `/orgs/${hostPublic}/contests`, first)).status).toBe(409);
    });
});

describe("seeing contests", () => {
    it("keeps a draft to the host's staff and shows a published public contest to everyone", async () => {
        const contest = await create();
        expect((await call(DAVE, "GET", `/contests/${contest.id}`)).status).toBe(404);
        expect((await call(CAROL, "GET", `/contests/${contest.id}`)).status).toBe(404); // a member is not staff
        expect((await call(BOB, "GET", `/contests/${contest.id}`)).status).toBe(200);
        await call(ALICE, "POST", `/contests/${contest.id}/publish`);
        for (const who of [DAVE, CAROL, null])
            expect((await call(who, "GET", `/contests/${contest.id}`)).status).toBe(200);
        const anonymous = contestSchema.parse(
            await (await call(null, "GET", `/contests/${contest.id}`)).json(),
        );
        expect(anonymous).toMatchObject({ registered: null, can_manage: false, problems: [] }); // problems wait for the start
    });

    it("lists public published contests for everyone and an organization's drafts for its staff only", async () => {
        const draft = await create();
        const open = await published();
        const publicIds = contestsResponseSchema
            .parse(await (await call(null, "GET", "/contests?limit=50")).json())
            .contests.map((c) => c.id);
        expect(publicIds).toContain(open.id);
        expect(publicIds).not.toContain(draft.id);
        const mine = contestsResponseSchema.parse(
            await (await call(ALICE, "GET", `/contests?org_id=${hostPublic}&limit=50`)).json(),
        );
        expect(mine.contests.map((c) => c.id)).toEqual(expect.arrayContaining([draft.id, open.id]));
        const theirs = contestsResponseSchema.parse(
            await (await call(DAVE, "GET", `/contests?org_id=${hostPublic}&limit=50`)).json(),
        );
        expect(theirs.contests.map((c) => c.id)).not.toContain(draft.id);
    });

    it("pages in newest-first order without repeating or losing a contest", async () => {
        for (let i = 0; i < 3; i++) await published();
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 20; page++) {
            const query: string = `/contests?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
            const body = contestsResponseSchema.parse(
                await (await call(null, "GET", query)).json(),
            );
            seen.push(...body.contests.map((c) => c.id));
            cursor = body.next_cursor;
            if (cursor === null) break;
        }
        expect(new Set(seen).size).toBe(seen.length);
        expect([...seen].sort().reverse()).toEqual(seen);
    });
});

const status = async (user: string | null, method: string, path: string, body?: unknown) =>
    (await call(user, method, path, body)).status;

describe("changing a contest", () => {
    it("lets the owner edit a draft and its problems, and nobody edit a published contest", async () => {
        const contest = await create({ problems: [] });
        const at = `/contests/${contest.id}`;
        const patched = await call(ALICE, "PATCH", at, { title: "Renamed", rated: true });
        expect(contestSchema.parse(await patched.json())).toMatchObject({
            title: "Renamed",
            rated: true,
        });
        expect(await status(ALICE, "PATCH", at, { title: "x", extra: 1 })).toBe(400);
        expect(await status(ALICE, "PATCH", at, { ends_at: iso(HOUR) })).toBe(400);
        expect(await status(BOB, "PATCH", at, { title: "no" })).toBe(403);
        const problem = { label: "A", task_version_id: version };
        expect(await status(ALICE, "POST", `${at}/problems`, problem)).toBe(201);
        expect(await status(ALICE, "POST", `${at}/problems`, problem)).toBe(409);
        expect(await status(BOB, "POST", `${at}/problems`, { ...problem, label: "B" })).toBe(404);
        expect(await status(ALICE, "DELETE", `${at}/problems/A`)).toBe(204);
        expect(await status(ALICE, "DELETE", `${at}/problems/A`)).toBe(404);
        await call(ALICE, "POST", `${at}/problems`, problem);
        await call(ALICE, "POST", `${at}/publish`);
        expect(await status(ALICE, "PATCH", at, { title: "late" })).toBe(409);
        expect(await status(ALICE, "POST", `${at}/problems`, { ...problem, label: "B" })).toBe(409);
        expect(await status(ALICE, "DELETE", `${at}/problems/A`)).toBe(409);
    });
});

describe("publishing a contest", () => {
    it("publishes once, before the start, only for owners and admins, only with a problem", async () => {
        const empty = await create({ problems: [] });
        expect((await call(ALICE, "POST", `/contests/${empty.id}/publish`)).status).toBe(409);
        const contest = await create();
        expect((await call(BOB, "POST", `/contests/${contest.id}/publish`)).status).toBe(403);
        expect((await call(DAVE, "POST", `/contests/${contest.id}/publish`)).status).toBe(404);
        expect((await call(ALICE, "POST", `/contests/${contest.id}/publish`)).status).toBe(200);
        expect((await call(ALICE, "POST", `/contests/${contest.id}/publish`)).status).toBe(409);
        const soon = await create({ starts_at: iso(60_000), ends_at: iso(HOUR), freeze_at: null });
        h.clock.advance(2 * 60_000);
        expect((await call(ALICE, "POST", `/contests/${soon.id}/publish`)).status).toBe(409); // already past its start
    });
});

describe("registering and the clock", () => {
    it("lets strangers and members register, late joins too, and refuses organizers", async () => {
        const contest = await published();
        const status = async (who: string | null) =>
            (await call(who, "POST", `/contests/${contest.id}/registrations`)).status;
        expect(await status(DAVE)).toBe(201);
        expect(await status(DAVE)).toBe(200);
        expect(
            registrationResponseSchema.parse(
                await (await call(DAVE, "POST", `/contests/${contest.id}/registrations`)).json(),
            ).status,
        ).toBe("already");
        expect(await status(CAROL)).toBe(201);
        expect(await status(ALICE)).toBe(403); // the host's owner
        expect(await status(BOB)).toBe(403); // a setter
        expect(await status(null)).toBe(401);
        const mine = contestSchema.parse(
            await (await call(DAVE, "GET", `/contests/${contest.id}`)).json(),
        );
        expect(mine.registered).toBe(true);
    });
});

describe("the clock", () => {
    it("moves the contest with the clock, shows its problems once it starts, closes registration at the end, and audits it", async () => {
        const contest = await published({
            starts_at: iso(HOUR),
            ends_at: iso(2 * HOUR),
            freeze_at: iso(90 * 60_000),
        });
        const context = {
            clock: h.clock,
            inTransaction: <T>(work: Parameters<typeof withRequestContext<T>>[2]) =>
                withRequestContext(h.db.database.sql, WORKER, work),
        };
        const problemsSeen = async () =>
            contestSchema.parse(await (await call(null, "GET", `/contests/${contest.id}`)).json());
        expect((await problemsSeen()).problems).toEqual([]);
        h.clock.advance(HOUR + 1000);
        await advanceContests(context);
        const running = await problemsSeen();
        expect(running.state).toBe("running");
        expect(running.problems).toEqual([{ label: "A", points: 100 }]);
        expect((await call(DAVE, "POST", `/contests/${contest.id}/registrations`)).status).toBe(
            201,
        );
        h.clock.advance(HOUR);
        expect(await advanceContests(context)).toBeGreaterThanOrEqual(1);
        expect((await problemsSeen()).state).toBe("ended");
        expect((await call(CAROL, "POST", `/contests/${contest.id}/registrations`)).status).toBe(
            404,
        ); // closed
        expect((await call(ALICE, "POST", `/contests/${contest.id}/finalize`)).status).toBe(200);
        expect((await call(ALICE, "POST", `/contests/${contest.id}/finalize`)).status).toBe(409);
        const audit = await h.db.database
            .sql`select action from audit_log where target = ${contest.id} order by seq`;
        const actions = audit.map((row) => String(row["action"]));
        expect(actions).toEqual(
            expect.arrayContaining([
                "contest.created",
                "contest.published",
                "contest.state_changed",
                "contest.registered",
                "contest.finalized",
            ]),
        );
    });
});
