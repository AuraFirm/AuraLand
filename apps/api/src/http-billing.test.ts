// Goal: plans through the real HTTP app and PostgreSQL. Members read their organization's entitlements (the free plan until a
// platform administrator says otherwise); a stranger gets the same 404 as for a missing organization; only a platform
// administrator changes a plan, and the change shows up in the audit log; billing references are not for ordinary members.
import { entitlementsSchema, planChangedSchema } from "@aura/contracts/api/billing";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3"; // a stranger to the organization
let h: Harness;
let org = "";
let orgPublic = "";

beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`update users set platform_role = 'admin' where id = ${ALICE}`;
    await sql`insert into users (id, email, email_verified_at) values (${CAROL}, 'carol@example.com', now())`;
    const [o] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'plan-team', 'Plan Team') returning id`;
    org = o?.id ?? "";
    orgPublic = `org_${org}`;
    await sql`insert into memberships (org_id, user_id, role) values (${org}, ${BOB}, 'member')`;
});
afterAll(async () => {
    await h.drop();
});

const call = async (user: string, method: string, path: string, payload?: unknown) =>
    h.request(path, {
        method,
        headers: browser(
            (await h.login(user)).token,
            payload === undefined ? {} : { "content-type": "application/json" },
        ),
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });

describe("reading a plan", () => {
    it("shows a member the free plan until one is set", async () => {
        const response = await call(BOB, "GET", `/orgs/${orgPublic}/plan`);
        expect(response.status).toBe(200);
        const plan = entitlementsSchema.parse(await response.json());
        expect(plan).toMatchObject({ plan: "free", sso: false, webhook_endpoints_max: 0 });
    });

    it("answers a stranger exactly as it answers for an organization that does not exist", async () => {
        const stranger = await call(CAROL, "GET", `/orgs/${orgPublic}/plan`);
        const missing = await call(
            CAROL,
            "GET",
            "/orgs/org_018f0000-0000-7000-8000-00000000ffff/plan",
        );
        expect(stranger.status).toBe(404);
        expect(missing.status).toBe(404);
        // Only the request id may differ.
        const { request_id: _a, ...strangerBody } = z
            .record(z.string(), z.unknown())
            .parse(await stranger.json());
        const { request_id: _b, ...missingBody } = z
            .record(z.string(), z.unknown())
            .parse(await missing.json());
        expect(strangerBody).toEqual(missingBody);
    });
});

describe("changing a plan", () => {
    it("is refused to an ordinary member and to a stranger, and nothing changes", async () => {
        for (const user of [BOB, CAROL]) {
            const response = await call(user, "PUT", `/admin/orgs/${orgPublic}/plan`, {
                plan: "enterprise",
            });
            expect(response.status).toBe(404);
        }
        const [row] = await h.db.database.sql`select count(*)::int as n from customers`;
        expect(row?.["n"]).toBe(0);
    });

    it("lets a platform administrator set it, audits it, and members then see it", async () => {
        h.clock.advance(61_000);
        const set = await call(ALICE, "PUT", `/admin/orgs/${orgPublic}/plan`, {
            plan: "enterprise",
            contract_ref: "C-1",
        });
        expect(set.status).toBe(200);
        const changed = planChangedSchema.parse(await set.json());
        expect(changed.entitlements).toMatchObject({ plan: "enterprise", sso: true, scim: true });

        const seen = entitlementsSchema.parse(
            await (await call(BOB, "GET", `/orgs/${orgPublic}/plan`)).json(),
        );
        expect(seen.plan).toBe("enterprise");
        const audit = await h.db.database
            .sql`select detail from audit_log where action = 'billing.plan_set'`;
        expect(audit.length).toBe(1);
    });

    it("keeps billing references from ordinary members", async () => {
        // An ordinary member of the organization, acting as the application role, sees no customer row at all.
        const rows = await withRequestContext(
            h.db.database.sql,
            { role: "aura_app", actorKind: "user", userId: BOB, orgIds: [org] },
            (tx) => tx`select contract_ref from customers where org_id = ${org}`,
        );
        expect(rows.length).toBe(0);
    });

    it("refuses an unknown plan", async () => {
        h.clock.advance(61_000);
        const response = await call(ALICE, "PUT", `/admin/orgs/${orgPublic}/plan`, {
            plan: "platinum",
        });
        expect(response.status).toBe(400);
    });
});
