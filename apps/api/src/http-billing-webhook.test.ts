// Goal: the payment provider's webhook through the real HTTP app and PostgreSQL. Nothing changes without a genuine, fresh signature
// over the exact bytes; a genuine event is applied once however often it is delivered; an older event cannot undo a newer one;
// a plan staff set by hand is never changed by the provider; and without a configured secret the route does not exist.
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createHarness, type Harness, START } from "./http-harness.ts";

const SECRET = "whsec_test_secret_value";
let h: Harness;
let org = "";
let staffOrg = "";

beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    const orgs = await sql<{ id: string; slug: string }[]>`insert into orgs (kind, slug, name)
        values ('company', 'hook-team', 'Hook Team'), ('company', 'staff-team', 'Staff Team') returning id, slug`;
    org = orgs.find((o) => o.slug === "hook-team")?.id ?? "";
    staffOrg = orgs.find((o) => o.slug === "staff-team")?.id ?? "";
});
afterAll(async () => {
    await h.drop();
});

const outcomeOf = async (response: Response) =>
    z.object({ received: z.literal(true), outcome: z.string() }).parse(await response.json())
        .outcome;
const nowS = () => Math.floor(h.clock.nowUnixMs() / 1000);
const sign = (body: string, t: number, secret = SECRET) =>
    createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

function post(
    body: string,
    headers: Record<string, string>,
    env: Record<string, string> = { AURA_STRIPE_WEBHOOK_SECRET: SECRET },
) {
    return h.app(env).request("/api/webhooks/stripe", { method: "POST", headers, body });
}
const signed = (body: string, t = nowS()) => ({ "stripe-signature": `t=${t},v1=${sign(body, t)}` });
const checkout = (id: string, orgId: string, plan: string, created = nowS()) =>
    JSON.stringify({
        id,
        type: "checkout.session.completed",
        created,
        data: {
            object: { client_reference_id: `org_${orgId}`, customer: "cus_9", metadata: { plan } },
        },
    });
const planOf = async (orgId: string) => {
    const [row] = await h.db.database
        .sql`select plan, source from customers where org_id = ${orgId}`;
    return row === undefined ? null : `${row["plan"]}/${row["source"]}`;
};

describe("the signature is the credential", () => {
    it("refuses a missing, forged, tampered, stale or future signature and changes nothing", async () => {
        const body = checkout("evt_a", org, "team");
        const t = nowS();
        const refusals: { headers: Record<string, string>; tamper?: true }[] = [
            { headers: {} },
            {
                headers: {
                    "stripe-signature": `t=${t},v1=${sign(body, t, "whsec_wrong_wrong_wrong")}`,
                },
            },
            { headers: { "stripe-signature": `t=${t},v1=${sign(body, t)}` }, tamper: true },
            { headers: signed(body, t - 301) },
            { headers: signed(body, t + 301) },
        ];
        for (const [i, refusal] of refusals.entries()) {
            const response = await post(refusal.tamper ? `${body} ` : body, refusal.headers);
            expect(response.status, `case ${i}`).toBe(400);
        }
        expect(await planOf(org)).toBeNull();
        const [events] = await h.db.database.sql`select count(*)::int as n from billing_events`;
        expect(events?.["n"]).toBe(0);
    });

    it("does not exist when no secret is configured", async () => {
        const body = checkout("evt_b", org, "team");
        const response = await post(body, signed(body), {});
        expect(response.status).toBe(404);
        expect(await planOf(org)).toBeNull();
    });
});

describe("applying events", () => {
    it("applies a genuine checkout once, however often it is delivered", async () => {
        const body = checkout("evt_c", org, "team", nowS());
        const first = await post(body, signed(body));
        expect(first.status).toBe(200);
        expect(await first.json()).toEqual({ received: true, outcome: "applied" });
        expect(await planOf(org)).toBe("team/provider");
        const again = await post(body, signed(body));
        expect(await again.json()).toEqual({ received: true, outcome: "duplicate" });
        const [events] = await h.db.database
            .sql`select count(*)::int as n from billing_events where provider_event_id = 'evt_c'`;
        expect(events?.["n"]).toBe(1);
    });

    it("refuses an older event after a newer one (they can arrive out of order)", async () => {
        const base = nowS();
        const newer = checkout("evt_d", org, "enterprise", base + 10);
        const older = checkout("evt_e", org, "team", base + 5);
        expect(await outcomeOf(await post(newer, signed(newer)))).toBe("applied");
        expect(await outcomeOf(await post(older, signed(older)))).toBe("stale");
        expect(await planOf(org)).toBe("enterprise/provider");
    });

    it("puts the organization back on free when its subscription ends", async () => {
        const body = JSON.stringify({
            id: "evt_f",
            type: "customer.subscription.deleted",
            created: nowS() + 20,
            data: { object: { metadata: { org_id: `org_${org}` } } },
        });
        expect(await outcomeOf(await post(body, signed(body)))).toBe("applied");
        expect(await planOf(org)).toBe("free/provider");
    });
});

describe("applying events, continued", () => {
    it("never changes a plan staff set by hand", async () => {
        const { sql } = h.db.database;
        await sql`insert into customers (org_id, plan, updated_by, updated_at, source)
            values (${staffOrg}, 'enterprise', '018f0000-0000-7000-8000-0000000000a1', now(), 'staff')`;
        const body = checkout("evt_g", staffOrg, "team", nowS() + 30);
        expect(await outcomeOf(await post(body, signed(body)))).toBe("staff_managed");
        expect(await planOf(staffOrg)).toBe("enterprise/staff");
    });

    it("records but ignores events it cannot use, and never invents a plan", async () => {
        for (const [id, body] of [
            ["evt_h", checkout("evt_h", org, "platinum", nowS() + 40)],
            [
                "evt_i",
                checkout("evt_i", "018f0000-0000-7000-8000-00000000dead", "team", nowS() + 41),
            ],
            [
                "evt_j",
                JSON.stringify({
                    id: "evt_j",
                    type: "invoice.paid",
                    created: nowS(),
                    data: { object: {} },
                }),
            ],
        ] as const) {
            const response = await post(body, signed(body));
            expect(await outcomeOf(response), id).toBe("ignored");
        }
        expect(await planOf(org)).toBe("free/provider");
    });

    it("keeps the record of an event as it was", async () => {
        const { sql } = h.db.database;
        await expect(sql`update billing_events set outcome = 'applied'`).rejects.toThrow();
        await expect(sql`delete from billing_events`).rejects.toThrow();
    });

    it("needs no session and no CSRF header, and the clock starts where the harness says", async () => {
        expect(START).toBeGreaterThan(0);
        const body = checkout("evt_k", org, "team", nowS() + 50);
        const response = await post(body, signed(body)); // no cookie, no origin
        expect(response.status).toBe(200);
    });
});
