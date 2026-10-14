// Goal: human attacks on a task version are evidence nobody can rewrite, written by people other than
// the author, on versions worth attacking, and read only by the people who work on the task. Setup runs
// as the database owner; behaviour under test runs as the application role with a real context.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const U = (n: number) => `018f0000-0000-7000-8000-00000000020${n}`;
const OWNER = U(1);
const SETTER = U(2);
const REVIEWER = U(3);
const OTHER_REVIEWER = U(4);
const MEMBER = U(5);
const OUTSIDER = U(6);
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

let db: TestDatabase;
let team = "";
let versionId = "";
beforeAll(async () => {
    db = await createMigratedTestDatabase(8);
    const { sql } = db.database;
    for (const n of [1, 2, 3, 4, 5, 6])
        await sql`insert into users (id, email) values (${U(n)}, ${`a${n}@example.com`})`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'atk-team', 'x') returning id`;
    team = org?.id ?? "";
    const [other] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'atk-other', 'x') returning id`;
    await sql`insert into memberships (org_id, user_id, role) values
        (${team}, ${OWNER}, 'owner'), (${team}, ${SETTER}, 'setter'), (${team}, ${REVIEWER}, 'reviewer'),
        (${team}, ${OTHER_REVIEWER}, 'reviewer'), (${team}, ${MEMBER}, 'member'), (${other?.id ?? ""}, ${OUTSIDER}, 'owner')`;
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${team}, 'atk-task', 'algorithmic', 'private', 'T', ${SETTER}) returning id`;
    // REVIEWER is assigned to the task; OTHER_REVIEWER is not.
    await sql`insert into task_assignments (task_id, org_id, user_id, assigned_by, created_at)
        values (${task?.id ?? ""}, ${team}, ${REVIEWER}, ${OWNER}, now())`;
    const [version] = await sql<
        { id: string }[]
    >`insert into task_versions (org_id, task_id, seq, created_by)
        values (${team}, ${task?.id ?? ""}, 1, ${SETTER}) returning id`;
    versionId = version?.id ?? "";
    await sql`update task_versions set state = 'uploaded', bundle_bytes = 9, bundle_sha256 = ${randomBytes(32)} where id = ${versionId}`;
    await sql`update task_versions set spec = ${sql.json({ spec_version: 1 })}, statement = 'x' where id = ${versionId}`;
});
afterAll(async () => {
    await db.drop();
});

const attack = (userId: string, outcome = "held", method = "printed the samples") =>
    inRole(
        db.database,
        "aura_app",
        as(userId),
        (tx) =>
            tx<
                { id: string }[]
            >`insert into attack_findings (org_id, task_version_id, author_id, outcome, method, created_at)
            values (${team}, ${versionId}, ${userId}, ${outcome}, ${method}, now()) returning id`,
    );
const toReview = () =>
    db.database
        .sql`update task_versions set state = 'in_review' where id = ${versionId} and state = 'uploaded'`;

describe("attack findings", () => {
    it("cannot be written until the version is in a state worth attacking", async () => {
        await fails(attack(OWNER), /cannot be attacked/);
        await toReview();
        expect((await attack(OWNER)).length).toBe(1);
    });

    it("are written by owners, admins and assigned reviewers, never by the author or anyone else", async () => {
        await toReview();
        expect((await attack(REVIEWER, "gamed", "echo the input")).length).toBe(1);
        await fails(attack(SETTER), /row-level security|their own version/);
        await fails(attack(OTHER_REVIEWER), /row-level security/); // a reviewer not assigned to this task
        await fails(attack(MEMBER), /row-level security/);
        await fails(attack(OUTSIDER), /row-level security/);
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(OWNER),
                (
                    tx,
                ) => tx`insert into attack_findings (org_id, task_version_id, author_id, outcome, method, created_at)
                values (${team}, ${versionId}, ${REVIEWER}, 'held', 'forged author', now())`,
            ),
            /row-level security/,
        );
    });

    it("refuse the author even when the author is an owner of the organization", async () => {
        const { sql } = db.database;
        const [task] = await sql<
            { id: string }[]
        >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
            values (${team}, 'atk-own', 'algorithmic', 'private', 'T', ${OWNER}) returning id`;
        const [own] = await sql<
            { id: string }[]
        >`insert into task_versions (org_id, task_id, seq, created_by)
            values (${team}, ${task?.id ?? ""}, 1, ${OWNER}) returning id`;
        const id = own?.id ?? "";
        await sql`update task_versions set state = 'uploaded', bundle_bytes = 9, bundle_sha256 = ${randomBytes(32)} where id = ${id}`;
        await sql`update task_versions set spec = ${sql.json({ spec_version: 1 })}, statement = 'x' where id = ${id}`;
        await sql`update task_versions set state = 'in_review' where id = ${id}`;
        await fails(
            inRole(
                db.database,
                "aura_app",
                as(OWNER),
                (
                    tx,
                ) => tx`insert into attack_findings (org_id, task_version_id, author_id, outcome, method, created_at)
                values (${team}, ${id}, ${OWNER}, 'held', 'my own work', now())`,
            ),
            /nobody attacks their own version/,
        );
    });
});

describe("attack findings, content and visibility", () => {
    it("hold only the outcomes and sizes the table allows", async () => {
        await toReview();
        await fails(attack(OWNER, "maybe"), /attack_findings_outcome/);
        await fails(attack(OWNER, "held", ""), /attack_findings_method/);
        await fails(attack(OWNER, "held", "x".repeat(4001)), /attack_findings_method/);
    });

    it("never change and are never deleted", async () => {
        await toReview();
        const [row] = await attack(OWNER);
        await fails(
            db.database
                .sql`update attack_findings set outcome = 'held' where id = ${row?.id ?? ""}`,
            /never changes/,
        );
        await fails(
            db.database.sql`delete from attack_findings where id = ${row?.id ?? ""}`,
            /never changes/,
        );
    });

    it("are read by owners, and by setters and reviewers of the task, nobody else", async () => {
        await toReview();
        const read = (userId: string) =>
            inRole(db.database, "aura_app", as(userId), (tx) => tx`select id from attack_findings`);
        for (const reader of [OWNER, SETTER, REVIEWER])
            expect((await read(reader)).length).toBeGreaterThan(0);
        for (const blocked of [OTHER_REVIEWER, MEMBER, OUTSIDER])
            expect((await read(blocked)).length).toBe(0);
    });
});
