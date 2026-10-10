// Goal: the task tables enforce their own rules, so no application bug can break them. Who may read
// and write each table comes from the organization role; a version moves only along allowed pairs;
// a released version is frozen; a creator never reviews or releases their own work; counts are
// capped. Each check names the rule it protects. Setup runs as the database owner; every behaviour
// under test runs as the application role with a real request context.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const U = (n: number) => `018f0000-0000-7000-8000-00000000000${n}`;
const OWNER = U(1);
const SETTER = U(2);
const REVIEWER = U(3);
const MEMBER = U(4);
const OUTSIDER = U(5);
const SETTER_TWO = U(6);
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

let db: TestDatabase;
let team = "";
let elsewhere = "";
beforeAll(async () => {
    db = await createMigratedTestDatabase(10);
    const { sql } = db.database;
    for (const n of [1, 2, 3, 4, 5, 6])
        await sql`insert into users (id, email) values (${U(n)}, ${`user${n}@example.com`})`;
    team = await newOrg("task-team");
    elsewhere = await newOrg("other-team");
    await sql`insert into memberships (org_id, user_id, role) values
        (${team}, ${OWNER}, 'owner'), (${team}, ${SETTER}, 'setter'), (${team}, ${REVIEWER}, 'reviewer'),
        (${team}, ${MEMBER}, 'member'), (${team}, ${SETTER_TWO}, 'setter'), (${elsewhere}, ${OUTSIDER}, 'owner')`;
});
afterAll(async () => {
    await db.drop();
});

async function newOrg(slug: string): Promise<string> {
    const [row] = await db.database.sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', ${slug}, 'x') returning id`;
    return row?.id ?? "";
}

let counter = 0;
const createTask = (userId: string, org = team, visibility = "private") =>
    inRole(
        db.database,
        "aura_app",
        as(userId),
        (tx) =>
            tx<
                { id: string }[]
            >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
            values (${org}, ${`task-${++counter}`}, 'algorithmic', ${visibility}, 'A task', ${userId})
            returning id`,
    );

const createVersion = (userId: string, taskId: string, seq: number, org = team) =>
    inRole(
        db.database,
        "aura_app",
        as(userId),
        (tx) =>
            tx<{ id: string }[]>`insert into task_versions (org_id, task_id, seq, created_by)
            values (${org}, ${taskId}, ${seq}, ${userId}) returning id`,
    );

// A task with one draft version made by SETTER.
async function draft(visibility = "private") {
    const [task] = await createTask(SETTER, team, visibility);
    const [version] = await createVersion(SETTER, task?.id ?? "", 1);
    return { taskId: task?.id ?? "", versionId: version?.id ?? "" };
}

const move = (userId: string, versionId: string, changes: Record<string, unknown>) =>
    inRole(
        db.database,
        "aura_app",
        as(userId),
        (tx) => tx`update task_versions set ${tx(changes)} where id = ${versionId} returning id`,
    );
const BUNDLE = () => ({ bundle_bytes: 1000, bundle_sha256: randomBytes(32) });
const CONTENT = { spec: { spec_version: 1 }, statement: "Add two numbers." };

async function toReview(versionId: string) {
    expect((await move(SETTER, versionId, { state: "uploaded", ...BUNDLE() })).length).toBe(1);
    expect((await move(SETTER, versionId, { ...CONTENT })).length).toBe(1);
    expect((await move(SETTER, versionId, { state: "in_review" })).length).toBe(1);
}
const review = (userId: string, versionId: string, outcome = "approved") =>
    inRole(
        db.database,
        "aura_app",
        as(userId),
        (tx) =>
            tx<
                { id: string }[]
            >`insert into task_reviews (org_id, task_version_id, reviewer_id, outcome)
            values (${team}, ${versionId}, ${userId}, ${outcome}) returning id`,
    );
const release = (userId: string, versionId: string, waived: boolean) =>
    move(userId, versionId, {
        state: "released",
        waived,
        released_by: userId,
        released_at: new Date(),
    });

describe("roles", () => {
    it("accepts setter and reviewer and still refuses unknown roles", async () => {
        const { sql } = db.database;
        const org = await newOrg("roles-team");
        await sql`insert into users (id, email) values ('018f0000-0000-7000-8000-0000000000a1', 'a1@example.com')`;
        await sql`insert into memberships (org_id, user_id, role) values (${org}, '018f0000-0000-7000-8000-0000000000a1', 'reviewer')`;
        await fails(
            sql`update memberships set role = 'boss' where org_id = ${org}`,
            /memberships_role/,
        );
    });
});

describe("tasks", () => {
    it("lets owners and setters create, and nobody else, and never as someone else", async () => {
        expect((await createTask(OWNER)).length).toBe(1);
        expect((await createTask(SETTER)).length).toBe(1);
        await fails(createTask(REVIEWER), /row-level security/);
        await fails(createTask(MEMBER), /row-level security/);
        await fails(createTask(OUTSIDER), /row-level security/);
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(SETTER),
                (tx) =>
                    tx`insert into tasks (org_id, slug, kind, title, created_by) values (${team}, 'forged-by', 'function', 'x', ${OWNER})`,
            ),
            /row-level security/,
        );
    });

    it("shows private tasks to content roles only and org tasks to every member", async () => {
        const [privateTask] = await createTask(SETTER, team, "private");
        const [orgTask] = await createTask(SETTER, team, "org");
        const see = async (user: string) =>
            (
                await inRole(
                    db.database,
                    "aura_app",
                    as(user),
                    (tx) =>
                        tx<
                            { id: string }[]
                        >`select id from tasks where id in (${privateTask?.id ?? ""}, ${orgTask?.id ?? ""})`,
                )
            ).map((row) => row.id);
        expect((await see(SETTER)).length).toBe(2);
        expect((await see(REVIEWER)).length).toBe(2);
        expect(await see(MEMBER)).toEqual([orgTask?.id]);
        expect(await see(OUTSIDER)).toEqual([]);
    });
});

describe("tasks: fixed fields and caps", () => {
    it("keeps kind, slug and organization fixed, and checks the shape", async () => {
        const [task] = await createTask(SETTER);
        const id = task?.id ?? "";
        const rename = (user: string, title: string) =>
            inRole(
                db.database,
                "aura_app",
                as(user),
                (tx) => tx`update tasks set title = ${title} where id = ${id} returning id`,
            );
        expect((await rename(SETTER, "Renamed")).length).toBe(1);
        expect((await rename(REVIEWER, "Hacked")).length).toBe(0);
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(SETTER),
                (tx) => tx`update tasks set kind = 'sql' where id = ${id}`,
            ),
            /permission denied/,
        );
        await fails(
            db.database.sql`update tasks set kind = 'sql' where id = ${id}`,
            /keeps its kind/,
        );
        await fails(
            db.database.sql`update tasks set slug = 'other-slug' where id = ${id}`,
            /keeps its kind/,
        );
        await fails(
            db.database
                .sql`insert into tasks (org_id, slug, kind, title, created_by) values (${team}, 'bad-kind', 'nothing', 'x', ${OWNER})`,
            /tasks_kind/,
        );
        await fails(db.database.sql`update tasks set title = '' where id = ${id}`, /tasks_title/);
    });

    it("caps tasks per organization at 1000", async () => {
        const org = await newOrg("full-team");
        await db.database.sql`insert into tasks (org_id, slug, kind, title, created_by)
            select ${org}, 'bulk-' || n, 'function', 'x', ${OWNER} from generate_series(1, 1000) n`;
        await fails(
            db.database
                .sql`insert into tasks (org_id, slug, kind, title, created_by) values (${org}, 'one-too-many', 'function', 'x', ${OWNER})`,
            /at most 1000 tasks/,
        );
    });
});

describe("versions: creation and visibility", () => {
    it("numbers versions consecutively and starts them as drafts", async () => {
        const { taskId } = await draft();
        await fails(createVersion(SETTER, taskId, 3), /consecutive/);
        await fails(createVersion(SETTER, taskId, 1), /consecutive/);
        expect((await createVersion(SETTER, taskId, 2)).length).toBe(1);
        await fails(
            db.database
                .sql`insert into task_versions (org_id, task_id, seq, state, created_by) values (${team}, ${taskId}, 3, 'uploaded', ${SETTER})`,
            /starts as a draft/,
        );
        await fails(createVersion(REVIEWER, taskId, 3), /row-level security/);
        await fails(createVersion(MEMBER, taskId, 3), /row-level security/);
        await fails(createVersion(OUTSIDER, taskId, 3, elsewhere), /violates foreign key/);
    });

    it("hides unreleased versions from plain members and everything from outsiders", async () => {
        const { taskId, versionId } = await draft("org");
        const count = async (user: string) =>
            (
                await inRole(
                    db.database,
                    "aura_app",
                    as(user),
                    (tx) => tx`select id from task_versions where id = ${versionId}`,
                )
            ).length;
        expect(await count(SETTER)).toBe(1);
        expect(await count(REVIEWER)).toBe(1);
        expect(await count(MEMBER)).toBe(0);
        expect(await count(OUTSIDER)).toBe(0);
        await toReview(versionId);
        await review(REVIEWER, versionId);
        await release(REVIEWER, versionId, true);
        expect(await count(MEMBER)).toBe(1);
        expect(taskId).not.toBe("");
    });

    it("refuses oversized or malformed content", async () => {
        const { versionId } = await draft();
        const { sql } = db.database;
        await fails(
            sql`update task_versions set statement = '' where id = ${versionId}`,
            /statement_size/,
        );
        await fails(
            sql`update task_versions set bundle_bytes = 67108865, bundle_sha256 = ${randomBytes(32)} where id = ${versionId}`,
            /bundle_size/,
        );
        await fails(
            sql`update task_versions set bundle_bytes = 5, bundle_sha256 = ${randomBytes(31)} where id = ${versionId}`,
            /bundle_hash/,
        );
        await fails(
            sql`update task_versions set bundle_bytes = 5 where id = ${versionId}`,
            /bundle_pair/,
        );
    });
});

describe("versions: the life cycle", () => {
    it("moves only along allowed pairs", async () => {
        const { versionId } = await draft();
        const { sql } = db.database;
        await fails(
            sql`update task_versions set state = 'released' where id = ${versionId}`,
            /cannot move from draft to released/,
        );
        await fails(
            sql`update task_versions set state = 'in_review' where id = ${versionId}`,
            /cannot move from draft to in_review/,
        );
        await fails(
            sql`update task_versions set state = 'uploaded' where id = ${versionId}`,
            /bundle_present/,
        );
        await toReview(versionId);
        await fails(
            sql`update task_versions set state = 'draft' where id = ${versionId}`,
            /cannot move|draft_empty/,
        );
        await fails(
            sql`update task_versions set state = 'validated' where id = ${versionId}`,
            /cannot move from in_review to validated/,
        );
    });

    it("needs content before review and never replaces a bundle", async () => {
        const { versionId } = await draft();
        expect((await move(SETTER, versionId, { state: "uploaded", ...BUNDLE() })).length).toBe(1);
        await fails(move(SETTER, versionId, { state: "in_review" }), /content_present/);
        await fails(move(SETTER, versionId, BUNDLE()), /never replaced/);
    });

    it("keeps editing to writers and review moves to reviewers", async () => {
        const { versionId } = await draft();
        expect((await move(MEMBER, versionId, { statement: "x" })).length).toBe(0);
        expect((await move(REVIEWER, versionId, { statement: "x" })).length).toBe(0);
        await toReview(versionId);
        // In review the setter can no longer edit; the reviewer can send it back.
        expect((await move(SETTER, versionId, { statement: "edited" })).length).toBe(0);
        expect((await move(REVIEWER, versionId, { state: "uploaded" })).length).toBe(1);
        expect((await move(SETTER, versionId, { statement: "edited" })).length).toBe(1);
    });

    it("never lets a creator review or release their own version", async () => {
        const [task] = await createTask(OWNER);
        const [own] = await createVersion(OWNER, task?.id ?? "", 1);
        const id = own?.id ?? "";
        expect((await move(OWNER, id, { state: "uploaded", ...BUNDLE() })).length).toBe(1);
        expect((await move(OWNER, id, { ...CONTENT, state: "in_review" })).length).toBe(1);
        await fails(review(OWNER, id), /nobody reviews their own version/);
        await review(REVIEWER, id);
        await fails(release(OWNER, id, true), /no_self_release/);
        expect((await release(REVIEWER, id, true)).length).toBe(1);
    });
});

describe("versions: review and release", () => {
    it("needs an approving review, and marks a release waived exactly when it skipped validation", async () => {
        const { versionId } = await draft();
        await toReview(versionId);
        await fails(release(REVIEWER, versionId, true), /needs an approving review/);
        await review(REVIEWER, versionId, "changes_requested");
        await fails(release(REVIEWER, versionId, true), /needs an approving review/);
        await review(REVIEWER, versionId, "approved");
        await fails(release(REVIEWER, versionId, false), /waived exactly when/);
        expect((await release(REVIEWER, versionId, true)).length).toBe(1);

        const second = await draft();
        await toReview(second.versionId);
        await review(REVIEWER, second.versionId);
        expect((await move(REVIEWER, second.versionId, { state: "validating" })).length).toBe(1);
        expect((await move(REVIEWER, second.versionId, { state: "validated" })).length).toBe(1);
        await fails(release(REVIEWER, second.versionId, true), /waived exactly when/);
        expect((await release(REVIEWER, second.versionId, false)).length).toBe(1);
    });

    it("only reviews versions that are in review", async () => {
        const { versionId } = await draft();
        await fails(review(REVIEWER, versionId), /only a version in review/);
    });
});

describe("versions: frozen and unique", () => {
    it("freezes a released version except for retiring it, and never deletes it", async () => {
        const { versionId } = await draft();
        await toReview(versionId);
        await review(REVIEWER, versionId);
        await release(REVIEWER, versionId, true);
        const { sql } = db.database;
        for (const change of [
            sql`update task_versions set statement = 'changed' where id = ${versionId}`,
            sql`update task_versions set spec = '{}'::jsonb where id = ${versionId}`,
            sql`update task_versions set bundle_sha256 = ${randomBytes(32)} where id = ${versionId}`,
            sql`update task_versions set waived = false where id = ${versionId}`,
            sql`update task_versions set state = 'in_review' where id = ${versionId}`,
        ])
            await fails(change, /released version does not change/);
        await fails(sql`delete from task_versions where id = ${versionId}`, /cannot be deleted/);
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(OWNER),
                (tx) => tx`delete from task_versions where id = ${versionId}`,
            ),
            /permission denied/,
        );
        expect((await move(REVIEWER, versionId, { state: "retired" })).length).toBe(1);
        await fails(
            sql`update task_versions set state = 'released' where id = ${versionId}`,
            /retired version does not change/,
        );
    });

    it("has at most one released and one validating version per task", async () => {
        const { taskId, versionId } = await draft();
        await toReview(versionId);
        await review(REVIEWER, versionId);
        await release(REVIEWER, versionId, true);
        const [next] = await createVersion(SETTER, taskId, 2);
        const nextId = next?.id ?? "";
        await move(SETTER, nextId, { state: "uploaded", ...BUNDLE() });
        await move(SETTER, nextId, { ...CONTENT });
        await move(SETTER, nextId, { state: "in_review" });
        await review(REVIEWER, nextId);
        await fails(release(REVIEWER, nextId, true), /task_versions_one_released/);
        await move(REVIEWER, versionId, { state: "retired" });
        expect((await release(REVIEWER, nextId, true)).length).toBe(1);
    });

    it("lets only one version of a task be validated at a time", async () => {
        const { taskId, versionId } = await draft();
        await toReview(versionId);
        await move(REVIEWER, versionId, { state: "validating" });
        const [next] = await createVersion(SETTER, taskId, 2);
        const nextId = next?.id ?? "";
        await move(SETTER, nextId, { state: "uploaded", ...BUNDLE() });
        await move(SETTER, nextId, { ...CONTENT });
        await move(SETTER, nextId, { state: "in_review" });
        await fails(move(REVIEWER, nextId, { state: "validating" }), /one_validating/);
    });
});

describe("reviews", () => {
    it("are visible to content roles only, and are decisions nobody can edit or delete", async () => {
        const { versionId } = await draft();
        await toReview(versionId);
        const [made] = await review(REVIEWER, versionId, "changes_requested");
        const see = (user: string) =>
            inRole(
                db.database,
                "aura_app",
                as(user),
                (tx) => tx`select id from task_reviews where id = ${made?.id ?? ""}`,
            );
        expect((await see(SETTER)).length).toBe(1);
        expect((await see(MEMBER)).length).toBe(0);
        await fails(review(MEMBER, versionId), /row-level security/);
        await fails(review(SETTER_TWO, versionId), /row-level security/);
        await fails(review(SETTER, versionId), /nobody reviews their own version/);
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(REVIEWER),
                (tx) => tx`update task_reviews set outcome = 'approved'`,
            ),
            /permission denied/,
        );
        await fails(
            inRole(db.database, "aura_app", as(REVIEWER), (tx) => tx`delete from task_reviews`),
            /permission denied/,
        );
    });
});

const start = (userId: string, versionId: string, overrides: Record<string, unknown> = {}) =>
    inRole(db.database, "aura_app", as(userId), (tx) => {
        const row = {
            org_id: team,
            task_version_id: versionId,
            started_by: userId,
            storage_upload_id: "upload-abc",
            expected_bytes: 20 * 1024 * 1024,
            expected_sha256: randomBytes(32),
            part_bytes: 8 * 1024 * 1024,
            part_count: 3,
            expires_at: new Date(Date.now() + 3600_000),
            ...overrides,
        };
        return tx<{ id: string }[]>`insert into bundle_uploads ${tx(row)} returning id`;
    });

describe("bundle uploads", () => {
    it("checks the part arithmetic and the lifetime", async () => {
        const { versionId } = await draft();
        expect((await start(SETTER, versionId)).length).toBe(1);
        await fails(start(SETTER, versionId, { part_count: 2 }), /bundle_uploads_parts/);
        await fails(start(SETTER, versionId, { part_count: 4 }), /bundle_uploads_parts/);
        await fails(start(SETTER, versionId, { part_bytes: 1024 }), /bundle_uploads_parts/);
        await fails(
            start(SETTER, versionId, { expected_bytes: 64 * 1024 * 1024 + 1, part_count: 9 }),
            /bundle_uploads_bytes/,
        );
        await fails(
            start(SETTER, versionId, { expires_at: new Date(Date.now() + 7200_000) }),
            /lifetime/,
        );
    });

    it("limits who can start and read, and caps unfinished uploads per person at five", async () => {
        const { versionId } = await draft();
        await fails(start(MEMBER, versionId), /row-level security/);
        await fails(start(REVIEWER, versionId), /row-level security/);
        await fails(start(SETTER, versionId, { started_by: OWNER }), /row-level security/);
        for (let index = 0; index < 4; index++) await start(SETTER_TWO, versionId);
        expect((await start(SETTER_TWO, versionId)).length).toBe(1);
        await fails(start(SETTER_TWO, versionId), /at most 5 unfinished/);
        const [mine] = await start(SETTER, versionId);
        const see = (user: string) =>
            inRole(
                db.database,
                "aura_app",
                as(user),
                (tx) => tx`select id from bundle_uploads where id = ${mine?.id ?? ""}`,
            );
        expect((await see(SETTER_TWO)).length).toBe(1);
        expect((await see(MEMBER)).length).toBe(0);
        expect((await see(OUTSIDER)).length).toBe(0);
    });

    it("ends once and keeps its declared size and hash", async () => {
        const { versionId } = await draft();
        const [upload] = await start(SETTER, versionId);
        const id = upload?.id ?? "";
        const finish = (user: string) =>
            inRole(
                db.database,
                "aura_app",
                as(user),
                (tx) =>
                    tx`update bundle_uploads set finished_at = now() where id = ${id} returning id`,
            );
        expect((await finish(SETTER_TWO)).length).toBe(0);
        await fails(
            db.database.sql`update bundle_uploads set expected_bytes = 5 where id = ${id}`,
            /keeps its declared/,
        );
        expect((await finish(SETTER)).length).toBe(1);
        await fails(finish(SETTER), /finished upload does not change/);
    });
});

describe("privileges", () => {
    it("lets the application role touch none of the hidden or system columns", async () => {
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(OWNER),
                (tx) => tx`update task_versions set created_by = ${SETTER}`,
            ),
            /permission denied/,
        );
        await fails(
            inRole(db.database, "aura_app", as(OWNER), (tx) => tx`delete from tasks`),
            /permission denied/,
        );
        const rows = await db.database.sql<{ role: string; allowed: boolean }[]>`
            select r as role, has_table_privilege(r, t, 'select') as allowed
            from unnest(array['aura_auth']) r, unnest(array['tasks', 'task_versions', 'task_reviews', 'bundle_uploads']) t`;
        for (const row of rows) expect(row.allowed).toBe(false);
    });
});
