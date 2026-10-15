// Goal: SCIM provisioning through the real HTTP app and PostgreSQL. A token belongs to one organization and one plan with
// provisioning; only people in a verified domain can be provisioned; the plan's room is respected; switching a person off removes
// their membership (never an owner's), ends their SSO sessions and stops them coming back through SSO; tokens are shown once.
import { scimTokenCreatedSchema, scimTokensResponseSchema } from "@aura/contracts/api/sso";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
let h: Harness;
let org = "";
let orgPublic = "";
let token = "";

beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`insert into users (id, email, email_verified_at) values (${CAROL}, 'carol@example.com', now())`;
    const [o] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'scim-co', 'Scim Co') returning id`;
    org = o?.id ?? "";
    orgPublic = `org_${org}`;
    await sql`insert into memberships (org_id, user_id, role) values (${org}, ${ALICE}, 'owner'), (${org}, ${BOB}, 'member')`;
    await sql`insert into customers (org_id, plan, updated_by, updated_at) values (${org}, 'enterprise', ${ALICE}, now())`;
    await sql`insert into sso_domains (org_id, domain, token, created_at, verified_at) values (${org}, 'acme.example', ${"b".repeat(32)}, now(), now())`;
});
afterAll(async () => {
    await h.drop();
});

const admin = async (user: string, method: string, path: string) => {
    h.clock.advance(61_000);
    return h.request(path, { method, headers: browser((await h.login(user)).token) });
};
const scim = (method: string, path: string, body?: unknown, bearer = token) =>
    Promise.resolve(
        h.app().request(`/api/scim/v2${path}`, {
            method,
            headers: {
                authorization: `Bearer ${bearer}`,
                "content-type": "application/scim+json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
    );
const user = z.object({ id: z.string(), userName: z.string(), active: z.boolean() });

describe("tokens", () => {
    it("are shown once, listed without the secret, and for owners and administrators of a plan that has provisioning", async () => {
        expect((await admin(BOB, "POST", `/orgs/${orgPublic}/scim-tokens`)).status).toBe(403);
        expect((await admin(CAROL, "POST", `/orgs/${orgPublic}/scim-tokens`)).status).toBe(404);
        const made = scimTokenCreatedSchema.parse(
            await (await admin(ALICE, "POST", `/orgs/${orgPublic}/scim-tokens`)).json(),
        );
        token = made.token;
        expect(made.base_url).toMatch(/\/api\/scim\/v2$/);
        const listed = await (await admin(ALICE, "GET", `/orgs/${orgPublic}/scim-tokens`)).text();
        expect(listed).not.toContain(token);
        expect(scimTokensResponseSchema.parse(JSON.parse(listed)).tokens).toHaveLength(1);
        const [stored] = await h.db.database
            .sql`select count(*)::int as n from scim_tokens where token_hash = sha256(${Buffer.from(token)})`;
        expect(stored?.["n"]).toBe(1);
    });

    it("are refused on a plan without provisioning", async () => {
        await h.db.database
            .sql`update customers set plan = 'team', updated_at = now() where org_id = ${org}`;
        expect((await admin(ALICE, "POST", `/orgs/${orgPublic}/scim-tokens`)).status).toBe(402);
        expect((await scim("GET", "/Users")).status).toBe(401); // an existing token stops working too
        await h.db.database
            .sql`update customers set plan = 'enterprise', updated_at = now() where org_id = ${org}`;
    });
});

describe("authentication", () => {
    it("needs a valid bearer token", async () => {
        for (const bearer of ["", "x".repeat(43), "short"])
            expect((await scim("GET", "/Users", undefined, bearer)).status, bearer).toBe(401);
        const none = await h.app().request("/api/scim/v2/Users", { method: "GET" });
        expect(none.status).toBe(401);
        expect(await none.json()).toMatchObject({
            schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
            status: "401",
        });
    });
});

describe("provisioning", () => {
    it("creates a person in a verified domain: an account, a membership, a record", async () => {
        const response = await scim("POST", "/Users", {
            userName: "Dana@Acme.example",
            externalId: "dana-1",
            name: { givenName: "Dana" },
        });
        expect(response.status).toBe(201);
        const created = user.parse(await response.json());
        expect(created).toMatchObject({ userName: "dana@acme.example", active: true });
        const [member] = await h.db.database
            .sql`select m.role from memberships m where m.org_id = ${org} and m.user_id = ${created.id}`;
        expect(member?.["role"]).toBe("member");
        expect((await scim("GET", `/Users/${created.id}`)).status).toBe(200);
        const found = z
            .object({ totalResults: z.number() })
            .parse(
                await (await scim("GET", '/Users?filter=userName eq "dana@acme.example"')).json(),
            );
        expect(found.totalResults).toBe(1);
    });

    it("refuses a second creation, an address outside the domains, a bad body and an unsupported filter", async () => {
        expect((await scim("POST", "/Users", { userName: "dana@acme.example" })).status).toBe(409);
        expect((await scim("POST", "/Users", { userName: "eve@elsewhere.example" })).status).toBe(
            400,
        );
        expect((await scim("POST", "/Users", { userName: "not-an-email" })).status).toBe(400);
        expect((await scim("GET", '/Users?filter=userName co "a"')).status).toBe(400);
        expect((await scim("GET", "/Users/not-an-id")).status).toBe(404);
    });

    it("never shows another organization's people", async () => {
        const [other] = await h.db.database.sql<
            { id: string }[]
        >`insert into users (email, email_verified_at) values ('zed@acme.example', now()) returning id`;
        expect((await scim("GET", `/Users/${other?.id}`)).status).toBe(404);
    });

    it("respects the plan's room and leaves no stray account", async () => {
        await h.db.database
            .sql`update customers set plan = 'free', updated_at = now() where org_id = ${org}`;
        await h.db.database
            .sql`insert into users (email, email_verified_at) select 'f' || n || '@elsewhere.example', now() from generate_series(1, 7) n`;
        await h.db.database
            .sql`insert into memberships (org_id, user_id, role) select ${org}, id, 'member' from users where email like 'f%@elsewhere.example' on conflict do nothing`;
        // The free plan has no provisioning, so the token is refused; give it room by moving the limit instead.
        await h.db.database
            .sql`update customers set plan = 'enterprise', updated_at = now() where org_id = ${org}`;
        await h.db.database.sql`update plans set members_max = 10 where key = 'enterprise'`;
        const full = await scim("POST", "/Users", { userName: "full@acme.example" });
        expect(full.status).toBe(403);
        const [stray] = await h.db.database
            .sql`select count(*)::int as n from users where email = 'full@acme.example'`;
        expect(stray?.["n"]).toBe(0);
        await h.db.database.sql`update plans set members_max = 10000 where key = 'enterprise'`;
    });
});

describe("switching a person off", () => {
    const deactivate = async (id: string, body: unknown) => scim("PATCH", `/Users/${id}`, body);

    it("removes the membership, ends their SSO sessions, and keeps them from signing in through SSO again", async () => {
        const created = user.parse(
            await (await scim("POST", "/Users", { userName: "gil@acme.example" })).json(),
        );
        await h.db.database
            .sql`insert into sessions (user_id, token_hash, auth_method, privileged, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
            values (${created.id}, ${Buffer.alloc(32, 9)}, 'sso', false, now(), now(), now() + interval '1 day', now() + interval '7 days')`;
        const response = await deactivate(created.id, {
            Operations: [{ op: "Replace", path: "active", value: "False" }],
        });
        expect(response.status).toBe(200);
        expect(user.parse(await response.json()).active).toBe(false);
        const [gone] = await h.db.database
            .sql`select count(*)::int as n from memberships where org_id = ${org} and user_id = ${created.id}`;
        expect(gone?.["n"]).toBe(0);
        const [session] = await h.db.database
            .sql`select revoked_reason from sessions where user_id = ${created.id}`;
        expect(session?.["revoked_reason"]).toBe("admin");
        const [inactive] = await h.db.database
            .sql`select sso_scim_inactive(${org}, ${created.id}) as v`;
        expect(inactive?.["v"]).toBe(true);
        const back = await deactivate(created.id, {
            Operations: [{ op: "replace", value: { active: true } }],
        });
        expect(user.parse(await back.json()).active).toBe(true);
        const [rejoined] = await h.db.database
            .sql`select count(*)::int as n from memberships where org_id = ${org} and user_id = ${created.id}`;
        expect(rejoined?.["n"]).toBe(1);
    });

    it("never removes an owner, and DELETE forgets the person", async () => {
        const created = user.parse(
            await (await scim("POST", "/Users", { userName: "hope@acme.example" })).json(),
        );
        await h.db.database
            .sql`update memberships set role = 'owner' where org_id = ${org} and user_id = ${created.id}`;
        await deactivate(created.id, { active: false });
        const [kept] = await h.db.database
            .sql`select role from memberships where org_id = ${org} and user_id = ${created.id}`;
        expect(kept?.["role"]).toBe("owner");
        expect((await scim("DELETE", `/Users/${created.id}`)).status).toBe(204);
        expect((await scim("GET", `/Users/${created.id}`)).status).toBe(404);
        expect((await scim("DELETE", `/Users/${created.id}`)).status).toBe(404);
    });

    it("revoking the token stops the provider at once", async () => {
        const listed = scimTokensResponseSchema.parse(
            await (await admin(ALICE, "GET", `/orgs/${orgPublic}/scim-tokens`)).json(),
        );
        const id = listed.tokens[0]?.id ?? "";
        expect((await admin(BOB, "DELETE", `/scim-tokens/${id}`)).status).toBe(404);
        expect((await admin(ALICE, "DELETE", `/scim-tokens/${id}`)).status).toBe(204);
        expect((await scim("GET", "/Users")).status).toBe(401);
    });
});

describe("flooding", () => {
    it("is counted per address: a flood of bad tokens is answered 429 with a retry hint, while another address is unaffected", async () => {
        const app = h.app({ AURA_TRUST_EDGE_REQUEST_ID: "true" });
        const hit = (address: string) =>
            Promise.resolve(
                app.request("/api/scim/v2/Users", {
                    headers: {
                        authorization: `Bearer ${"x".repeat(43)}`,
                        "x-forwarded-for": address,
                    },
                }),
            );
        let last = 0;
        for (let i = 0; i < 301; i++) last = (await hit("198.51.100.200")).status;
        expect(last).toBe(429);
        const refused = await hit("198.51.100.200");
        expect(refused.headers.get("retry-after")).toMatch(/^[0-9]+$/);
        expect((await hit("198.51.100.201")).status).toBe(401);
    });
});
