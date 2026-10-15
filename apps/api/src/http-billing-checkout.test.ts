// Goal: buying a plan and opening the billing portal through the real HTTP app and PostgreSQL. Only an organization's owners and
// administrators may (a stranger sees 404, an ordinary member 403), behind a fresh passkey check; the provider is asked for exactly
// the organization and plan the caller named, with return addresses on our own origin; with no provider configured nothing is
// offered; and the portal exists only once something has been bought.
import { sessionUrlSchema } from "@aura/contracts/api/billing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness, ORIGIN } from "./http-harness.ts";
import { createFakePaymentProvider } from "./modules/billing/provider.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3"; // a stranger
const provider = createFakePaymentProvider();
let h: Harness;
let org = "";
let orgPublic = "";

beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`insert into users (id, email, email_verified_at) values (${CAROL}, 'carol@example.com', now())`;
    const [o] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'buy-team', 'Buy Team') returning id`;
    org = o?.id ?? "";
    orgPublic = `org_${org}`;
    await sql`insert into memberships (org_id, user_id, role) values (${org}, ${ALICE}, 'owner'), (${org}, ${BOB}, 'member')`;
});
afterAll(async () => {
    await h.drop();
});

const call = async (user: string, path: string, payload?: unknown, configured = true) => {
    h.clock.advance(61_000);
    const app = configured
        ? h.app({ AURA_BILLING_DRIVER: "fake" }, undefined, undefined, undefined, provider)
        : h.app();
    return app.request(`/api/v1${path}`, {
        method: "POST",
        headers: browser((await h.login(user)).token, { "content-type": "application/json" }),
        body: JSON.stringify(payload ?? {}),
    });
};

describe("checkout", () => {
    it("starts a checkout for the organization and plan asked for, and audits it", async () => {
        const response = await call(ALICE, `/orgs/${orgPublic}/billing/checkout`, { plan: "team" });
        expect(response.status).toBe(201);
        const { url } = sessionUrlSchema.parse(await response.json());
        expect(url).toBe("https://billing.fake.invalid/checkout/cs_fake_1");
        expect(provider.checkouts).toEqual([
            {
                orgPublicId: orgPublic,
                plan: "team",
                successUrl: `${ORIGIN}/orgs/${orgPublic}/billing?checkout=success`,
                cancelUrl: `${ORIGIN}/orgs/${orgPublic}/billing?checkout=cancelled`,
            },
        ]);
        const audit = await h.db.database
            .sql`select detail from audit_log where action = 'billing.checkout_started'`;
        expect(audit.length).toBe(1);
    });

    it("answers a stranger 404 and an ordinary member 403, and asks the provider nothing", async () => {
        const before = provider.checkouts.length;
        expect(
            (await call(CAROL, `/orgs/${orgPublic}/billing/checkout`, { plan: "team" })).status,
        ).toBe(404);
        expect(
            (await call(BOB, `/orgs/${orgPublic}/billing/checkout`, { plan: "team" })).status,
        ).toBe(403);
        expect(provider.checkouts.length).toBe(before);
    });

    it("refuses plans that cannot be bought by card, extra fields and a plan already held", async () => {
        for (const body of [
            { plan: "free" },
            { plan: "enterprise" },
            { plan: "gold" },
            {},
            { plan: "team", extra: 1 },
        ])
            expect((await call(ALICE, `/orgs/${orgPublic}/billing/checkout`, body)).status).toBe(
                400,
            );
        await h.db.database.sql`insert into customers (org_id, plan, updated_by, updated_at)
            values (${org}, 'team', ${ALICE}, now())`;
        expect(
            (await call(ALICE, `/orgs/${orgPublic}/billing/checkout`, { plan: "team" })).status,
        ).toBe(409);
    });

    it("offers nothing when no provider is configured", async () => {
        const response = await call(
            ALICE,
            `/orgs/${orgPublic}/billing/checkout`,
            { plan: "employer" },
            false,
        );
        expect(response.status).toBe(503);
    });
});

describe("the billing portal", () => {
    it("exists only once something has been bought, and then opens for the organization's customer", async () => {
        expect((await call(ALICE, `/orgs/${orgPublic}/billing/portal`)).status).toBe(404);
        await h.db.database.sql`update customers set billing_ref = 'cus_77' where org_id = ${org}`;
        const response = await call(ALICE, `/orgs/${orgPublic}/billing/portal`);
        expect(response.status).toBe(201);
        expect(sessionUrlSchema.parse(await response.json()).url).toBe(
            "https://billing.fake.invalid/portal/cus_77",
        );
        expect(provider.portals.at(-1)).toEqual({
            billingRef: "cus_77",
            returnUrl: `${ORIGIN}/orgs/${orgPublic}/billing`,
        });
        expect((await call(BOB, `/orgs/${orgPublic}/billing/portal`)).status).toBe(403);
        expect((await call(CAROL, `/orgs/${orgPublic}/billing/portal`)).status).toBe(404);
    });
});
