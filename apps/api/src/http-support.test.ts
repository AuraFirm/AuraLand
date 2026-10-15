// Goal: consented support access through the real HTTP app and PostgreSQL. Staff can read an account summary only while the person's
// own grant is live; every look is recorded in the same call and the person sees it; grants expire and can be ended; platform
// administrators and people in the middle of an exam sitting cannot be looked at; nothing here ever lets staff act as the person.
import { supportGrantsResponseSchema, supportOverviewSchema } from "@aura/contracts/api/support";
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3"; // the person being supported
const ADMIN2 = "018f0000-0000-7000-8000-0000000000d4"; // another platform administrator
let h: Harness;

beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`update users set platform_role = 'admin' where id = ${ALICE}`;
    await sql`insert into users (id, email, email_verified_at, platform_role) values (${CAROL}, 'carol@example.com', now(), 'none'), (${ADMIN2}, 'root@example.com', now(), 'admin')`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'sup-co', 'Sup Co') returning id`;
    await sql`insert into memberships (org_id, user_id, role) values (${org?.id ?? ""}, ${CAROL}, 'member')`;
});
afterAll(async () => {
    await h.drop();
});

const call = async (userId: string, method: string, path: string, body?: unknown) => {
    h.clock.advance(61_000);
    return h.request(path, {
        method,
        headers: browser(
            (await h.login(userId)).token,
            body === undefined ? {} : { "content-type": "application/json" },
        ),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
};
const look = (target: string) =>
    call(ALICE, "GET", `/admin/support/users/${encodeId("usr", target)}`);
const grant = (hours = 2) => call(CAROL, "POST", "/me/support-access", { hours });

describe("without consent", () => {
    it("staff see nothing, however they ask", async () => {
        expect((await look(CAROL)).status).toBe(404);
        expect((await look("018f0000-0000-7000-8000-00000000beef")).status).toBe(404);
    });

    it("an ordinary person cannot use the staff route, and cannot grant for someone else", async () => {
        expect(
            (await call(BOB, "GET", `/admin/support/users/${encodeId("usr", CAROL)}`)).status,
        ).toBe(404);
        expect((await call(CAROL, "POST", "/me/support-access", { hours: 25 })).status).toBe(400);
        expect(
            (await call(CAROL, "POST", "/me/support-access", { hours: 2, user_id: "x" })).status,
        ).toBe(400);
    });
});

describe("with consent", () => {
    it("shows a read-only summary, records the look, and lets the person see it", async () => {
        expect((await grant()).status).toBe(201);
        const response = await look(CAROL);
        expect(response.status).toBe(200);
        const overview = supportOverviewSchema.parse(await response.json());
        expect(overview).toMatchObject({ email: "carol@example.com", status: "active" });
        expect(overview.organizations.map((o) => o.role)).toContain("member");
        const mine = supportGrantsResponseSchema.parse(
            await (await call(CAROL, "GET", "/me/support-access")).json(),
        );
        expect(mine.grants[0]?.views).toEqual([
            { viewed_at: expect.any(String), admin_id: encodeId("usr", ALICE) },
        ]);
        const audit = await h.db.database
            .sql`select count(*)::int as n from audit_log where action in ('support.access_granted', 'support.account_viewed')`;
        expect(audit[0]?.["n"]).toBe(2);
    });

    it("shows nothing beyond the summary: no tokens, no hashes", async () => {
        const text = await (await look(CAROL)).text();
        expect(text).not.toMatch(/token|hash|secret/i);
    });

    it("ends when the person ends it, and when it expires", async () => {
        expect((await call(CAROL, "DELETE", "/me/support-access")).status).toBe(204);
        expect((await look(CAROL)).status).toBe(404);
        expect((await grant(1)).status).toBe(201);
        expect((await look(CAROL)).status).toBe(200);
        h.clock.advance(61 * 60_000);
        expect((await look(CAROL)).status).toBe(404);
    });

    it("is refused for other platform administrators and for a person in an exam sitting", async () => {
        await call(ADMIN2, "POST", "/me/support-access", { hours: 2 });
        expect((await look(ADMIN2)).status).toBe(404);
        expect((await grant()).status).toBe(201);
        const { sql } = h.db.database;
        const [org] = await sql<{ id: string }[]>`select id from orgs where slug = 'sup-co'`;
        const [exam] = await sql<
            { id: string }[]
        >`insert into exams (org_id, title, mode, duration_s, window_start, window_end, created_by)
            values (${org?.id ?? ""}, 'E', 'ai_free', 3600, '2030-01-01T09:00:00Z', '2030-01-01T13:00:00Z', ${ALICE}) returning id`;
        await sql`insert into exam_sessions (exam_id, org_id, user_id, state, consent_at, consent_text_version, started_at, deadline_at, created_at)
            values (${exam?.id ?? ""}, ${org?.id ?? ""}, ${CAROL}, 'started', now(), 1, now(), now() + interval '1 hour', now())`;
        expect((await look(CAROL)).status).toBe(404);
        await sql`update exam_sessions set state = 'submitted', submitted_at = now() where user_id = ${CAROL}`;
        expect((await look(CAROL)).status).toBe(200);
    });

    it("keeps the record of looks as it was", async () => {
        await expect(
            h.db.database.sql`update support_views set viewed_at = now()`,
        ).rejects.toThrow();
        await expect(h.db.database.sql`delete from support_views`).rejects.toThrow();
    });
});
