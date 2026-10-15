// Goal: single sign-on administration through the real HTTP app and PostgreSQL. Only an organization on a plan with SSO, and only its
// owners and administrators (behind a fresh passkey check), can connect a provider; the provider must describe itself as the issuer
// typed; the client secret is never readable; a domain is verified only when DNS shows the token, and by one organization only.
import {
    ssoConnectionSchema,
    ssoDomainSchema,
    ssoDomainsResponseSchema,
} from "@aura/contracts/api/sso";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { createFakeIdp, type FakeIdp } from "./modules/sso/fake-idp.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3"; // a stranger
const SECRET = "very-secret-client-secret";
let h: Harness;
let idp: FakeIdp;
let org = "";
let orgPublic = "";
let rival = "";
const dns = new Map<string, string[]>();
const txt = { resolveTxt: async (name: string) => dns.get(name) ?? [] };

beforeAll(async () => {
    h = await createHarness();
    idp = await createFakeIdp();
    const { sql } = h.db.database;
    await sql`insert into users (id, email, email_verified_at) values (${CAROL}, 'carol@example.com', now())`;
    const orgs = await sql<{ id: string; slug: string }[]>`insert into orgs (kind, slug, name)
        values ('company', 'sso-co', 'SSO Co'), ('company', 'rival-co', 'Rival Co') returning id, slug`;
    org = orgs.find((o) => o.slug === "sso-co")?.id ?? "";
    rival = orgs.find((o) => o.slug === "rival-co")?.id ?? "";
    orgPublic = `org_${org}`;
    await sql`insert into memberships (org_id, user_id, role) values (${org}, ${ALICE}, 'owner'), (${org}, ${BOB}, 'member'), (${rival}, ${CAROL}, 'owner')`;
    await sql`insert into customers (org_id, plan, updated_by, updated_at) values (${org}, 'enterprise', ${ALICE}, now()), (${rival}, 'enterprise', ${CAROL}, now())`;
});
afterAll(async () => {
    await h.drop();
});

const call = async (user: string, method: string, path: string, payload?: unknown) => {
    h.clock.advance(61_000);
    return h
        .app({}, undefined, undefined, undefined, undefined, {
            oidcTransport: idp,
            txtResolver: txt,
        })
        .request(`/api/v1${path}`, {
            method,
            headers: browser(
                (await h.login(user)).token,
                payload === undefined ? {} : { "content-type": "application/json" },
            ),
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
};
const save = (user = ALICE, over: Record<string, unknown> = {}) =>
    call(user, "PUT", `/orgs/${orgPublic}/sso`, {
        issuer: idp.issuer,
        client_id: idp.clientId,
        client_secret: SECRET,
        ...over,
    });

describe("the connection", () => {
    it("is saved when the provider describes itself as the issuer typed, and never shows the secret", async () => {
        const response = await save();
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toContain(SECRET);
        expect(ssoConnectionSchema.parse(JSON.parse(text))).toMatchObject({
            issuer: idp.issuer,
            client_id: idp.clientId,
        });
        const read = await call(ALICE, "GET", `/orgs/${orgPublic}/sso`);
        expect(await read.text()).not.toContain(SECRET);
        const [row] = await h.db.database
            .sql`select token_endpoint, jwks_uri from sso_connections where org_id = ${org}`;
        expect(row).toEqual({
            token_endpoint: idp.discovery.tokenEndpoint,
            jwks_uri: idp.discovery.jwksUri,
        });
    });

    it("is refused when the provider is unreachable, says it is someone else, or the address is not allowed", async () => {
        idp.discoverable = false;
        expect((await save()).status).toBe(400);
        idp.discoverable = true;
        expect((await save(ALICE, { issuer: "https://other.example.com" })).status).toBe(400);
        expect((await save(ALICE, { issuer: "http://idp.example.com" })).status).toBe(400);
        expect((await save(ALICE, { client_secret: "" })).status).toBe(400);
        expect((await save(ALICE, { extra: 1 })).status).toBe(400);
    });

    it("is for owners and administrators of an organization whose plan includes it", async () => {
        expect((await save(BOB)).status).toBe(403);
        expect((await save(CAROL)).status).toBe(404);
        await h.db.database
            .sql`update customers set plan = 'team', updated_at = now() where org_id = ${org}`;
        const refused = await save();
        expect(refused.status).toBe(402);
        expect(await refused.json()).toMatchObject({ code: "plan_limit_reached" });
        await h.db.database
            .sql`update customers set plan = 'enterprise', updated_at = now() where org_id = ${org}`;
    });

    it("keeps the client secret from the application role, even by mistake", async () => {
        const asOwner = (
            query: (
                tx: Parameters<Parameters<typeof withRequestContext>[2]>[0],
            ) => Promise<unknown>,
        ) =>
            withRequestContext(
                h.db.database.sql,
                { role: "aura_app", actorKind: "user", userId: ALICE, orgIds: [org] },
                query,
            );
        await expect(
            asOwner((tx) => tx`select client_secret from sso_connections`),
        ).rejects.toThrow(/permission denied/);
        await expect(asOwner((tx) => tx`select * from sso_connections`)).rejects.toThrow(
            /permission denied/,
        );
    });
});

describe("domains", () => {
    it("hands out the record to publish, the same one every time", async () => {
        const first = ssoDomainSchema.parse(
            await (
                await call(ALICE, "POST", `/orgs/${orgPublic}/sso/domains`, {
                    domain: "acme.example",
                })
            ).json(),
        );
        const again = ssoDomainSchema.parse(
            await (
                await call(ALICE, "POST", `/orgs/${orgPublic}/sso/domains`, {
                    domain: "acme.example",
                })
            ).json(),
        );
        expect(first).toEqual(again);
        expect(first).toMatchObject({ txt_name: "_aura-challenge.acme.example", verified: false });
        expect(first.txt_value).toMatch(/^aura-verify=[0-9a-f]{32}$/);
    });

    it("refuses things that are not domains", async () => {
        for (const domain of [
            "",
            "localhost",
            "ACME.example",
            "a_b.example",
            "-a.example",
            "http://acme.example",
            "acme.example/x",
        ])
            expect(
                (await call(ALICE, "POST", `/orgs/${orgPublic}/sso/domains`, { domain })).status,
                domain,
            ).toBe(400);
    });

    it("verifies only when DNS shows the token", async () => {
        const record = ssoDomainSchema.parse(
            await (
                await call(ALICE, "POST", `/orgs/${orgPublic}/sso/domains`, {
                    domain: "acme.example",
                })
            ).json(),
        );
        const verify = () =>
            call(ALICE, "POST", `/orgs/${orgPublic}/sso/domains/acme.example/verify`);
        expect((await verify()).status).toBe(409); // nothing published
        dns.set(record.txt_name, ["aura-verify=0000000000000000000000000000dead"]);
        expect((await verify()).status).toBe(409); // someone else's token
        dns.set(record.txt_name, ["v=spf1 -all", record.txt_value]);
        const done = await verify();
        expect(done.status).toBe(200);
        expect(ssoDomainsResponseSchema.parse(await done.json()).domains).toEqual([
            { ...record, verified: true },
        ]);
        expect(
            (await call(BOB, "POST", `/orgs/${orgPublic}/sso/domains/acme.example/verify`)).status,
        ).toBe(403);
    });
});

describe("domains, continued", () => {
    it("belongs to the first organization that proves it", async () => {
        const rivalPublic = `org_${rival}`;
        const claim = ssoDomainSchema.parse(
            await (
                await call(CAROL, "POST", `/orgs/${rivalPublic}/sso/domains`, {
                    domain: "acme.example",
                })
            ).json(),
        );
        dns.set(claim.txt_name, [claim.txt_value]); // the same name now carries both tokens
        dns.set(claim.txt_name, [claim.txt_value]);
        const result = await call(
            CAROL,
            "POST",
            `/orgs/${rivalPublic}/sso/domains/acme.example/verify`,
        );
        expect(result.status).toBe(409);
        const [row] = await h.db.database
            .sql`select count(*)::int as n from sso_domains where domain = 'acme.example' and verified_at is not null`;
        expect(row?.["n"]).toBe(1);
    });

    it("is for owners and administrators, and can be removed", async () => {
        expect((await call(BOB, "GET", `/orgs/${orgPublic}/sso/domains`)).status).toBe(403);
        expect((await call(CAROL, "GET", `/orgs/${orgPublic}/sso/domains`)).status).toBe(404);
        expect(
            (await call(ALICE, "DELETE", `/orgs/${orgPublic}/sso/domains/acme.example`)).status,
        ).toBe(204);
        expect(
            (await call(ALICE, "DELETE", `/orgs/${orgPublic}/sso/domains/acme.example`)).status,
        ).toBe(404);
        expect((await call(ALICE, "DELETE", `/orgs/${orgPublic}/sso`)).status).toBe(204);
        expect((await call(ALICE, "GET", `/orgs/${orgPublic}/sso`)).status).toBe(404);
    });
});
