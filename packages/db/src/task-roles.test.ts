// Goal: migration 0013 lets owners invite setters and reviewers and lets admins remove them (they
// hold no power over the organization), while admins still cannot invite them, remove other admins
// or owners, and nobody can be invited as an owner.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const U = (n: number) => `018f0000-0000-7000-8000-00000000010${n}`;
const OWNER = U(1);
const ADMIN = U(2);
const SETTER = U(3);
const REVIEWER = U(4);
const OTHER_ADMIN = U(5);
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);

let db: TestDatabase;
let team = "";
beforeAll(async () => {
    db = await createMigratedTestDatabase(6);
    const { sql } = db.database;
    for (const n of [1, 2, 3, 4, 5])
        await sql`insert into users (id, email) values (${U(n)}, ${`role${n}@example.com`})`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'roles-team', 'x') returning id`;
    team = org?.id ?? "";
    await sql`insert into memberships (org_id, user_id, role) values
        (${team}, ${OWNER}, 'owner'), (${team}, ${ADMIN}, 'admin'), (${team}, ${SETTER}, 'setter'),
        (${team}, ${REVIEWER}, 'reviewer'), (${team}, ${OTHER_ADMIN}, 'admin')`;
});
afterAll(async () => {
    await db.drop();
});

let counter = 0;
const invite = (userId: string, role: string) =>
    inRole(
        db.database,
        "aura_app",
        as(userId),
        (tx) =>
            tx`insert into org_invitations (org_id, email, role, token_hash, invited_by, created_at, expires_at)
            values (${team}, ${`invitee${++counter}@example.com`}, ${role}, ${randomBytes(32)}, ${userId}, now(), now() + interval '7 days')
            returning id`,
    );
const remove = (userId: string, target: string) =>
    inRole(
        db.database,
        "aura_app",
        as(userId),
        (tx) =>
            tx`delete from memberships where org_id = ${team} and user_id = ${target} returning user_id`,
    );

describe("invitations to the task roles", () => {
    it("lets owners invite setters, reviewers and admins, but never owners", async () => {
        for (const role of ["setter", "reviewer", "admin", "member"])
            expect((await invite(OWNER, role)).length).toBe(1);
        await fails(invite(OWNER, "owner"), /row-level security/);
    });

    it("lets admins invite plain members only", async () => {
        expect((await invite(ADMIN, "member")).length).toBe(1);
        for (const role of ["setter", "reviewer", "admin"])
            await fails(invite(ADMIN, role), /row-level security/);
    });
});

describe("removing people", () => {
    it("lets an admin remove a setter and a reviewer but not another admin or an owner", async () => {
        expect((await remove(ADMIN, OTHER_ADMIN)).length).toBe(0);
        expect((await remove(ADMIN, OWNER)).length).toBe(0);
        expect((await remove(ADMIN, SETTER)).length).toBe(1);
        expect((await remove(ADMIN, REVIEWER)).length).toBe(1);
    });
});
