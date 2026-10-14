// Goal: the database itself decides who may take part in a contest and see its problems: a registered
// person reads exactly the statements of their contest's problems from the start, never before and never
// anything else of the task; organizers and problem authors cannot compete; the clock (not a person)
// moves a contest; a published contest cannot be altered. Setup runs as the database owner; every
// behaviour under test runs as an application role with a real request context.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const U = (n: number) => `018f0000-0000-7000-8000-00000000050${n}`;
const HOST_OWNER = U(1);
const HOST_SETTER = U(2);
const HOST_MEMBER = U(3);
const STRANGER = U(4);
const STUDENT = U(5);
const OTHER_STUDENT = U(6);
const BANK_OWNER = U(7);
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const ANONYMOUS: RequestContext = { actorKind: "anonymous", userId: null, orgIds: [] };
const WORKER: RequestContext = { actorKind: "worker", userId: null, orgIds: [] };
const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

const T = (hours: number, minutes = 0) => new Date(Date.UTC(2026, 10, 1, 10 + hours, minutes)); // 1 Nov 2026, 10:00 UTC plus an offset
const START = T(0);
const FREEZE = T(4);
const END = T(5);
const BEFORE = T(-1);
const DURING = T(1);
const AFTER = T(6);

let db: TestDatabase;
let host = "";
let bank = "";
let company = "";
let hostVersion = "";
let bankVersion = "";
let companyVersion = "";
beforeAll(async () => {
    db = await createMigratedTestDatabase(10);
    const { sql } = db.database;
    for (const n of [1, 2, 3, 4, 5, 6, 7])
        await sql`insert into users (id, email) values (${U(n)}, ${`c${n}@example.com`})`;
    const org = async (kind: string, slug: string) => {
        const [row] = await sql<
            { id: string }[]
        >`insert into orgs (kind, slug, name) values (${kind}, ${slug}, ${slug}) returning id`;
        return row?.id ?? "";
    };
    [host, bank, company] = [
        await org("university", "uni"),
        await org("platform", "bank"),
        await org("company", "firm"),
    ];
    await sql`insert into memberships (org_id, user_id, role) values
        (${host}, ${HOST_OWNER}, 'owner'), (${host}, ${HOST_SETTER}, 'setter'), (${host}, ${HOST_MEMBER}, 'member'),
        (${bank}, ${BANK_OWNER}, 'owner'), (${company}, ${STRANGER}, 'owner')`;
    await sql`alter table task_versions disable trigger task_versions_guard`;
    const released = async (orgId: string, slug: string, visibility: string) => {
        const [task] = await sql<
            { id: string }[]
        >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
            values (${orgId}, ${slug}, 'algorithmic', ${visibility}, ${slug}, ${HOST_OWNER}) returning id`;
        const [v] = await sql<{ id: string }[]>`insert into task_versions
            (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
            values (${orgId}, ${task?.id ?? ""}, 1, 'released', ${sql.json({ spec_version: 1 })}, 'Add.', 10, ${randomBytes(32)}, ${HOST_OWNER}, ${BANK_OWNER}, now(), true, now())
            returning id`;
        return v?.id ?? "";
    };
    hostVersion = await released(host, "host-task", "private");
    bankVersion = await released(bank, "bank-task", "public");
    companyVersion = await released(company, "firm-task", "private");
    await sql`alter table task_versions enable trigger task_versions_guard`;
});
afterAll(async () => {
    await db.drop();
});

const app = <T>(ctx: RequestContext, work: Parameters<typeof inRole<T>>[3]) =>
    inRole(db.database, "aura_app", ctx, work);
const worker = <T>(work: Parameters<typeof inRole<T>>[3]) =>
    inRole(db.database, "aura_worker", WORKER, work);

let counter = 0;
async function makeContest(
    options: { visibility?: string; problems?: string[]; freeze?: boolean } = {},
): Promise<string> {
    const slug = `contest-${++counter}`;
    const rows = await app(
        as(HOST_OWNER),
        (tx) =>
            tx<
                { id: string }[]
            >`insert into contests (org_id, slug, title, format, rules, visibility, starts_at, ends_at, freeze_at, created_by)
            values (${host}, ${slug}, 'A contest', 'icpc', ${tx.json({ format: "icpc", penalty_minutes_per_wrong: 20 })},
                    ${options.visibility ?? "public"}, ${START}, ${END}, ${options.freeze === false ? null : FREEZE}, ${HOST_OWNER}) returning id`,
    );
    const id = rows[0]?.id ?? "";
    const problems = options.problems ?? [hostVersion, bankVersion];
    for (const [index, version] of problems.entries()) {
        await addProblem(id, version, String.fromCharCode(65 + index));
    }
    return id;
}
const addProblem = (id: string, version: string, label: string) =>
    app(as(HOST_OWNER), (tx) => tx`select add_contest_problem(${id}, ${label}, ${version}, 100)`);
const publish = (id: string, now = BEFORE) =>
    app(as(HOST_OWNER), (tx) => tx`select publish_contest(${id}, ${now})`);
const register = (userId: string, id: string, now = DURING) =>
    app(
        as(userId),
        (tx) => tx<{ r: string }[]>`select register_for_contest(${id}, ${now}) as r`,
    ).then((rows) => rows[0]?.r);
const advance = (now: Date) =>
    worker(
        (tx) =>
            tx<
                { contest_id: string; from_state: string; to_state: string }[]
            >`select * from advance_contests(${now})`,
    );
const movesOf = async (id: string, now: Date) =>
    (await advance(now)).filter((r) => r.contest_id === id).map((r) => r.to_state);
const stateOf = async (id: string) =>
    (await db.database.sql<{ state: string }[]>`select state from contests where id = ${id}`)[0]
        ?.state;
const readsVersion = async (userId: string, version: string) =>
    (await app(as(userId), (tx) => tx`select id from task_versions where id = ${version}`)).length;

describe("creating and arranging a contest", () => {
    it("is for owners and admins of a real organization, as a draft", async () => {
        const insert = (ctx: RequestContext, orgId: string, creator: string) =>
            app(
                ctx,
                (
                    tx,
                ) => tx`insert into contests (org_id, slug, title, format, rules, starts_at, ends_at, created_by)
                values (${orgId}, ${`x-${++counter}`}, 't', 'ioi', ${tx.json({ format: "ioi" })}, ${START}, ${END}, ${creator})`,
            );
        await insert(as(HOST_OWNER), host, HOST_OWNER);
        for (const who of [HOST_SETTER, HOST_MEMBER, STRANGER])
            await fails(insert(as(who), host, who), /row-level security/);
        // The state is not a column an organizer can set at all.
        await fails(
            app(
                as(HOST_OWNER),
                (
                    tx,
                ) => tx`insert into contests (org_id, slug, title, format, rules, starts_at, ends_at, created_by, state)
                values (${host}, 'sneaky', 't', 'ioi', ${tx.json({ format: "ioi" })}, ${START}, ${END}, ${HOST_OWNER}, 'running')`,
            ),
            /permission denied/,
        );
        const [personal] = await db.database.sql<
            { id: string }[]
        >`insert into orgs (kind, slug, name) values ('personal', 'p-0123456789', 'me') returning id`;
        await db.database
            .sql`insert into memberships (org_id, user_id, role) values (${personal?.id ?? ""}, ${HOST_OWNER}, 'owner')`;
        await fails(insert(as(HOST_OWNER), personal?.id ?? "", HOST_OWNER), /not a personal space/);
    });
});

describe("arranging problems", () => {
    it("takes released problems from the host or the platform bank, never from another company", async () => {
        const id = await makeContest({ problems: [hostVersion, bankVersion] });
        // Through the function an organizer cannot tell a foreign or unreleased version from a missing one.
        await fails(addProblem(id, companyVersion, "C"), /no such released version/);
        await fails(addProblem(id, hostVersion, "D"), /unique|duplicate/);
        const [draftTask] = await db.database.sql<
            { id: string }[]
        >`select id from tasks where org_id = ${host} limit 1`;
        const [notReleased] = await db.database.sql<
            { id: string }[]
        >`insert into task_versions (org_id, task_id, seq, created_by)
            values (${host}, ${draftTask?.id ?? ""}, 2, ${HOST_OWNER}) returning id`;
        await fails(addProblem(id, notReleased?.id ?? "", "E"), /no such released version/);
        await fails(
            app(
                as(HOST_SETTER),
                (tx) => tx`select add_contest_problem(${id}, 'F', ${hostVersion}, 100)`,
            ),
            /no such contest/,
        );
        // The guard trigger holds even for the database owner, whatever calls it.
        const insertDirectly = (version: string, orgId: string, label: string) =>
            db.database
                .sql`insert into contest_problems (contest_id, org_id, label, task_version_id, task_org_id)
                values (${id}, ${host}, ${label}, ${version}, ${orgId})`;
        await fails(
            insertDirectly(companyVersion, company, "G"),
            /host's problems or the platform bank/,
        );
        await fails(insertDirectly(notReleased?.id ?? "", host, "H"), /released versions only/);
        await fails(
            app(
                as(HOST_OWNER),
                (
                    tx,
                ) => tx`insert into contest_problems (contest_id, org_id, label, task_version_id, task_org_id)
            values (${id}, ${host}, 'I', ${hostVersion}, ${host})`,
            ),
            /permission denied/,
        );
    });
});

describe("publishing", () => {
    it("fixes the problem set and the rules once the contest is published", async () => {
        const id = await makeContest();
        await publish(id);
        expect(await stateOf(id)).toBe("scheduled");
        await fails(
            app(as(HOST_OWNER), (tx) => tx`select remove_contest_problem(${id}, 'A')`),
            /do not change/,
        );
        // A published contest is not the organizer's to edit: the row is simply not updatable.
        expect(
            await app(
                as(HOST_OWNER),
                (tx) => tx`update contests set title = 'new' where id = ${id} returning id`,
            ),
        ).toHaveLength(0);
        await fails(
            db.database
                .sql`update contests set rules = '{"format":"icpc","penalty_minutes_per_wrong":0}' where id = ${id}`,
            /does not change/,
        );
    });

    it("is published by an owner or admin before the start and only with a problem", async () => {
        const id = await makeContest();
        await fails(
            app(as(HOST_SETTER), (tx) => tx`select publish_contest(${id}, ${BEFORE})`),
            /no such draft contest/,
        );
        await fails(
            app(as(HOST_OWNER), (tx) => tx`select publish_contest(${id}, ${DURING})`),
            /before it starts/,
        );
        const empty = await makeContest({ problems: [] });
        await fails(publish(empty), /at least one problem/);
        await publish(id);
        await fails(publish(id), /no such draft contest/);
    });
});

describe("who can see a contest and its problem list", () => {
    it("shows a draft to host staff only, a published public one to everyone, a private one to members", async () => {
        const draft = await makeContest();
        const seen = async (ctx: RequestContext, id: string) =>
            (await app(ctx, (tx) => tx`select id from contests where id = ${id}`)).length;
        expect([
            await seen(as(HOST_OWNER), draft),
            await seen(as(HOST_SETTER), draft),
            await seen(as(HOST_MEMBER), draft),
            await seen(as(STRANGER), draft),
            await seen(ANONYMOUS, draft),
        ]).toEqual([1, 1, 0, 0, 0]);
        await publish(draft);
        expect([
            await seen(as(HOST_MEMBER), draft),
            await seen(as(STRANGER), draft),
            await seen(ANONYMOUS, draft),
        ]).toEqual([1, 1, 1]);
        const secret = await makeContest({ visibility: "private" });
        await publish(secret);
        expect([
            await seen(as(HOST_MEMBER), secret),
            await seen(as(STRANGER), secret),
            await seen(ANONYMOUS, secret),
        ]).toEqual([1, 0, 0]);
    });

    it("hides the problem list from the public until the contest starts", async () => {
        const id = await makeContest();
        await publish(id);
        const problems = async (ctx: RequestContext) =>
            (
                await app(
                    ctx,
                    (tx) => tx`select label from contest_problems where contest_id = ${id}`,
                )
            ).length;
        expect([
            await problems(as(STRANGER)),
            await problems(ANONYMOUS),
            await problems(as(HOST_SETTER)),
        ]).toEqual([0, 0, 2]);
        await advance(DURING);
        expect([await problems(as(STRANGER)), await problems(ANONYMOUS)]).toEqual([2, 2]);
    });
});

describe("reading a problem's statement", () => {
    it("is allowed to a registered person from the start, never before, and only for the contest's problems", async () => {
        const id = await makeContest({ problems: [hostVersion] });
        await publish(id);
        await register(STUDENT, id, BEFORE);
        expect(await readsVersion(STUDENT, hostVersion)).toBe(0); // scheduled: problems stay secret
        await advance(DURING);
        expect(await readsVersion(STUDENT, hostVersion)).toBe(1); // running and registered
        expect(await readsVersion(OTHER_STUDENT, hostVersion)).toBe(0); // not registered
        expect(await readsVersion(STUDENT, bankVersion)).toBe(0); // a problem of no contest of theirs
        expect(await readsVersion(STUDENT, companyVersion)).toBe(0);
        await advance(AFTER);
        expect(await readsVersion(STUDENT, hostVersion)).toBe(1); // ended: still readable
        await app(as(HOST_OWNER), (tx) => tx`select finalize_contest(${id}, ${AFTER})`);
        expect(await readsVersion(STUDENT, hostVersion)).toBe(1); // finalized: still readable
    });

    it("never opens another contest's problems to someone registered for a different contest", async () => {
        const first = await makeContest({ problems: [hostVersion] });
        const second = await makeContest({ problems: [bankVersion] });
        await publish(first);
        await publish(second);
        await register(OTHER_STUDENT, second, BEFORE);
        await advance(DURING);
        expect(await readsVersion(OTHER_STUDENT, bankVersion)).toBe(1);
        expect(await readsVersion(OTHER_STUDENT, hostVersion)).toBe(0);
    });

    it("opens nothing else of the task to a contestant", async () => {
        const id = await makeContest({ problems: [hostVersion] });
        await publish(id);
        await register(STUDENT, id, BEFORE);
        await advance(DURING);
        const { sql } = db.database;
        const [task] = await sql<
            { task_id: string }[]
        >`select task_id from task_versions where id = ${hostVersion}`;
        const hidden = [
            (tx: Parameters<Parameters<typeof app>[1]>[0]) =>
                tx`select id from tasks where id = ${task?.task_id ?? ""}`,
            (tx: Parameters<Parameters<typeof app>[1]>[0]) =>
                tx`select id from task_reviews where task_version_id = ${hostVersion}`,
            (tx: Parameters<Parameters<typeof app>[1]>[0]) =>
                tx`select id from bundle_uploads where task_version_id = ${hostVersion}`,
            (tx: Parameters<Parameters<typeof app>[1]>[0]) =>
                tx`select id from validation_reports where task_version_id = ${hostVersion}`,
            (tx: Parameters<Parameters<typeof app>[1]>[0]) =>
                tx`select id from version_comments where task_version_id = ${hostVersion}`,
            (tx: Parameters<Parameters<typeof app>[1]>[0]) =>
                tx`select id from attack_findings where task_version_id = ${hostVersion}`,
            (tx: Parameters<Parameters<typeof app>[1]>[0]) =>
                tx`select 1 from delivery_bundles where task_version_id = ${hostVersion}`,
        ];
        for (const query of hidden) expect((await app(as(STUDENT), query)).length).toBe(0);
    });
});

describe("registering", () => {
    it("is open to anyone signed in until the end, late joins included, and idempotent", async () => {
        const id = await makeContest();
        await publish(id);
        expect(await register(STUDENT, id, BEFORE)).toBe("registered");
        expect(await register(STUDENT, id, BEFORE)).toBe("already");
        await advance(DURING);
        expect(await register(OTHER_STUDENT, id, DURING)).toBe("registered"); // late join
        await fails(register(STRANGER, id, AFTER), /no such contest open/);
        await fails(
            app(ANONYMOUS, (tx) => tx`select register_for_contest(${id}, ${DURING})`),
            /sign in/,
        );
        const rows = await app(
            as(STUDENT),
            (tx) => tx`select user_id from registrations where contest_id = ${id}`,
        );
        expect(rows.length).toBe(1); // a person sees only their own registration
    });

    it("refuses organizers and the staff of any problem's organization", async () => {
        const id = await makeContest({ problems: [hostVersion, bankVersion] });
        await publish(id);
        for (const who of [HOST_OWNER, HOST_SETTER, BANK_OWNER])
            await fails(register(who, id, BEFORE), /do not compete/);
        expect(await register(HOST_MEMBER, id, BEFORE)).toBe("registered"); // a plain member of the host may
    });

    it("refuses a contest that is a draft, and a private one to people outside the host", async () => {
        const draft = await makeContest();
        await fails(register(STUDENT, draft, BEFORE), /no such contest open/);
        const secret = await makeContest({ visibility: "private" });
        await publish(secret);
        await fails(register(STUDENT, secret, BEFORE), /no such contest open/);
        expect(await register(HOST_MEMBER, secret, BEFORE)).toBe("registered");
    });

    it("cannot be done by writing the table directly", async () => {
        const id = await makeContest();
        await publish(id);
        await fails(
            app(
                as(STUDENT),
                (tx) =>
                    tx`insert into registrations (contest_id, user_id, created_at) values (${id}, ${STUDENT}, now())`,
            ),
            /permission denied/,
        );
    });
});

describe("the clock and the contest's life", () => {
    it("moves scheduled to running to frozen to ended on time, catching up through skipped states", async () => {
        const id = await makeContest();
        await publish(id);
        expect(await movesOf(id, T(0, -1))).toEqual([]);
        expect(await movesOf(id, START)).toEqual(["running"]);
        expect(await movesOf(id, START)).toEqual([]); // idempotent
        expect(await movesOf(id, FREEZE)).toEqual(["frozen"]);
        expect(await movesOf(id, END)).toEqual(["ended"]);
        const skipped = await makeContest({ freeze: false });
        await publish(skipped);
        expect(
            (await advance(AFTER)).filter((r) => r.contest_id === skipped).map((r) => r.to_state),
        ).toEqual(["running", "ended"]);
    });

    it("lets nobody move a contest by hand, and finalizes only an ended one, by its owner", async () => {
        const id = await makeContest();
        await publish(id);
        await fails(
            app(as(HOST_OWNER), (tx) => tx`update contests set state = 'running' where id = ${id}`),
            /permission denied|row-level security/,
        );
        await fails(
            app(as(HOST_OWNER), (tx) => tx`select finalize_contest(${id}, ${AFTER})`),
            /no such ended contest/,
        );
        await advance(AFTER);
        await fails(
            app(as(HOST_SETTER), (tx) => tx`select finalize_contest(${id}, ${AFTER})`),
            /no such ended contest/,
        );
        await app(as(HOST_OWNER), (tx) => tx`select finalize_contest(${id}, ${AFTER})`);
        expect(await stateOf(id)).toBe("finalized");
        await fails(
            db.database.sql`update contests set state = 'running' where id = ${id}`,
            /cannot move/,
        );
    });

    it("keeps a version used by a live contest from being retired, and frees it once finalized", async () => {
        const [task] = await db.database.sql<
            { id: string }[]
        >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
            values (${host}, ${`retire-${++counter}`}, 'algorithmic', 'private', 'r', ${HOST_OWNER}) returning id`;
        await db.database.sql`alter table task_versions disable trigger task_versions_guard`;
        const [v] = await db.database.sql<{ id: string }[]>`insert into task_versions
            (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
            values (${host}, ${task?.id ?? ""}, 1, 'released', '{}'::jsonb, 's', 10, ${randomBytes(32)}, ${HOST_OWNER}, ${BANK_OWNER}, now(), true, now()) returning id`;
        await db.database.sql`alter table task_versions enable trigger task_versions_guard`;
        const id = await makeContest({ problems: [v?.id ?? ""] });
        await publish(id);
        await fails(
            db.database.sql`update task_versions set state = 'retired' where id = ${v?.id ?? ""}`,
            /live contest/,
        );
        await advance(AFTER);
        await app(as(HOST_OWNER), (tx) => tx`select finalize_contest(${id}, ${AFTER})`);
        await db.database.sql`alter table task_versions disable trigger task_versions_guard`;
        await db.database.sql`update task_versions set state = 'retired' where id = ${v?.id ?? ""}`;
        await db.database.sql`alter table task_versions enable trigger task_versions_guard`;
    });
});
