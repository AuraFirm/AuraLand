// Goal: customer webhook endpoints through the real HTTP app and PostgreSQL. Owners and administrators register addresses (a fresh
// passkey check, the secret shown once and never again), the address policy is the strict one, the plan decides how many, a
// stranger sees 404 and an ordinary member 403 on the list, and the application role cannot read a secret even by mistake.
import {
    webhookDeliveriesResponseSchema,
    webhookSecretSchema,
    webhooksResponseSchema,
} from "@aura/contracts/api/webhooks";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3"; // a stranger
let h: Harness;
let org = "";
let orgPublic = "";

beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`insert into users (id, email, email_verified_at) values (${CAROL}, 'carol@example.com', now())`;
    const [o] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'hook-co', 'Hook Co') returning id`;
    org = o?.id ?? "";
    orgPublic = `org_${org}`;
    await sql`insert into memberships (org_id, user_id, role) values (${org}, ${ALICE}, 'owner'), (${org}, ${BOB}, 'member')`;
    await sql`insert into customers (org_id, plan, updated_by, updated_at) values (${org}, 'team', ${ALICE}, now())`;
});
afterAll(async () => {
    await h.drop();
});

const call = async (user: string, method: string, path: string, payload?: unknown) => {
    h.clock.advance(61_000);
    return h.request(path, {
        method,
        headers: browser(
            (await h.login(user)).token,
            payload === undefined ? {} : { "content-type": "application/json" },
        ),
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
};
const create = (
    user: string,
    url = "https://hooks.example.com/aura",
    events: string[] = ["env_run.finished"],
) => call(user, "POST", `/orgs/${orgPublic}/webhooks`, { url, events });

describe("registering an endpoint", () => {
    it("shows the secret once, lists the endpoint without it, and audits", async () => {
        const response = await create(ALICE);
        expect(response.status).toBe(201);
        const made = webhookSecretSchema.parse(await response.json());
        expect(made.webhook).toMatchObject({
            url: "https://hooks.example.com/aura",
            events: ["env_run.finished"],
            active: true,
        });
        const listed = await call(ALICE, "GET", `/orgs/${orgPublic}/webhooks`);
        const text = await listed.text();
        expect(text).not.toContain(made.secret);
        expect(webhooksResponseSchema.parse(JSON.parse(text)).webhooks.length).toBe(1);
        const audit = await h.db.database
            .sql`select detail from audit_log where action = 'webhook.created'`;
        expect(audit.length).toBe(1);
        expect(JSON.stringify(audit)).not.toContain(made.secret);
    });

    it("refuses addresses the strict policy refuses, and unknown events or extra fields", async () => {
        for (const url of [
            "http://hooks.example.com/",
            "https://127.0.0.1/",
            "https://hooks.example.com:8080/",
            "https://u:p@hooks.example.com/",
            "nonsense",
        ])
            expect((await create(ALICE, url)).status, url).toBe(400);
        expect((await create(ALICE, undefined, ["order.paid"])).status).toBe(400);
        expect((await create(ALICE, undefined, [])).status).toBe(400);
        expect(
            (
                await call(ALICE, "POST", `/orgs/${orgPublic}/webhooks`, {
                    url: "https://a.example.com/",
                    events: ["env_run.finished"],
                    x: 1,
                })
            ).status,
        ).toBe(400);
    });

    it("is for owners and administrators: a member gets 404 (the database's answer), a stranger 404", async () => {
        expect((await create(BOB)).status).toBe(404);
        expect((await create(CAROL)).status).toBe(404);
    });

    it("lets the plan decide how many, and the free plan none", async () => {
        for (let i = 0; i < 4; i++)
            expect((await create(ALICE, `https://h${i}.example.com/`)).status).toBe(201);
        const sixth = await create(ALICE, "https://h9.example.com/");
        expect(sixth.status).toBe(402);
        expect(await sixth.json()).toMatchObject({ code: "plan_limit_reached" });
        await h.db.database
            .sql`update customers set plan = 'free', updated_at = now() where org_id = ${org}`;
        expect((await create(ALICE, "https://free.example.com/")).status).toBe(402);
        await h.db.database
            .sql`update customers set plan = 'team', updated_at = now() where org_id = ${org}`;
    });
});

describe("reading and changing endpoints", () => {
    it("shows the list to owners and administrators only", async () => {
        expect((await call(BOB, "GET", `/orgs/${orgPublic}/webhooks`)).status).toBe(403);
        expect((await call(CAROL, "GET", `/orgs/${orgPublic}/webhooks`)).status).toBe(404);
    });

    it("rotates the secret (the old one stays for the overlap), switches an endpoint off, and keeps others out", async () => {
        const { sql } = h.db.database;
        await sql`update webhook_endpoints set active = false where org_id = ${org}`; // room under the plan again
        const made = webhookSecretSchema.parse(
            await (await create(ALICE, "https://rotate.example.com/")).json(),
        );
        const path = `/webhooks/${made.webhook.id}`;
        expect((await call(BOB, "POST", `${path}/rotate-secret`)).status).toBe(404);
        expect((await call(CAROL, "POST", `${path}/rotate-secret`)).status).toBe(404);
        const rotated = webhookSecretSchema.parse(
            await (await call(ALICE, "POST", `${path}/rotate-secret`)).json(),
        );
        expect(rotated.secret).not.toBe(made.secret);
        expect(rotated.webhook.secret_rotated_at).not.toBeNull();
        const [row] =
            await sql`select secret_current, secret_previous from webhook_endpoints where id = ${made.webhook.id.slice(4)}`;
        expect(row).toEqual({ secret_current: rotated.secret, secret_previous: made.secret });

        expect((await call(BOB, "DELETE", path)).status).toBe(404);
        expect((await call(ALICE, "DELETE", path)).status).toBe(204);
        expect((await call(ALICE, "DELETE", path)).status).toBe(404);
        expect((await call(ALICE, "POST", `${path}/rotate-secret`)).status).toBe(404); // a switched-off endpoint cannot be rotated
        const log = webhookDeliveriesResponseSchema.parse(
            await (await call(ALICE, "GET", `${path}/deliveries`)).json(),
        );
        expect(log.deliveries).toEqual([]);
        expect((await call(CAROL, "GET", `${path}/deliveries`)).status).toBe(404);
    });

    it("never lets the application role read a secret, even by mistake", async () => {
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
            asOwner((tx) => tx`select secret_current from webhook_endpoints`),
        ).rejects.toThrow(/permission denied/);
        await expect(asOwner((tx) => tx`select * from webhook_endpoints`)).rejects.toThrow(
            /permission denied/,
        );
        await expect(
            asOwner((tx) => tx`select id, url from webhook_endpoints`),
        ).resolves.toBeDefined();
    });
});
