// Goal: platform administrators run the order lifecycle over HTTP (create, add released versions, set an
// invoice reference, place, revoke), every change needs a fresh passkey check and leaves an audit row,
// placing creates the delivery and its watermark jobs together, and nobody else can even see the routes.
import { createHash } from "node:crypto";
import { orderSchema, ordersResponseSchema } from "@aura/contracts/api/orders";
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";

let h: Harness;
let customerOrg = "";
let releasedVersion = "";
let draftVersion = "";
beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`update users set platform_role = 'admin' where id = ${ALICE}`;
    const [seller] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'seller-co', 'Seller') returning id`;
    const [customer] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('ai_lab', 'customer-lab', 'Lab') returning id`;
    customerOrg = customer?.id ?? "";
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${seller?.id ?? ""}, 'sold', 'algorithmic', 'private', 'T', ${BOB}) returning id`;
    // The version state machine has its own tests; here a released row is planted with the guard off.
    await sql`alter table task_versions disable trigger task_versions_guard`;
    const hash = createHash("sha256").update("bundle").digest();
    const [released] = await sql<{ id: string }[]>`insert into task_versions
        (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
        values (${seller?.id ?? ""}, ${task?.id ?? ""}, 1, 'released', '{}'::jsonb, 'S', 6, ${hash}, ${BOB}, ${ALICE}, now(), true, now())
        returning id`;
    releasedVersion = released?.id ?? "";
    const [draft] = await sql<
        { id: string }[]
    >`insert into task_versions (org_id, task_id, seq, created_by)
        values (${seller?.id ?? ""}, ${task?.id ?? ""}, 2, ${BOB}) returning id`;
    draftVersion = draft?.id ?? "";
    await sql`alter table task_versions enable trigger task_versions_guard`;
});
afterAll(async () => {
    await h.drop();
});

const send = async (token: string | null, method: string, path: string, body?: unknown) =>
    h.request(`/admin/${path}`, {
        method,
        headers: browser(token, body === undefined ? {} : { "content-type": "application/json" }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

const orderRequest = () => ({
    customer_org_id: encodeId("org", customerOrg),
    title: "Pack for the lab",
    licence_terms: "Internal evaluation use only.",
    delivery_days: 30,
});

async function draftOrder(token: string) {
    const response = await send(token, "POST", "orders", orderRequest());
    expect(response.status).toBe(201);
    return orderSchema.parse(await response.json());
}

describe("the order lifecycle", () => {
    it("creates, fills, invoices and places an order, and places a delivery job with it", async () => {
        const { token } = await h.login(ALICE);
        const order = await draftOrder(token);
        expect(order.state).toBe("draft");
        const version = encodeId("tsv", releasedVersion);
        const added = await send(token, "POST", `orders/${order.id}/items`, {
            task_version_id: version,
        });
        expect(orderSchema.parse(await added.json()).items?.length).toBe(1);
        const invoiced = await send(token, "PUT", `orders/${order.id}/invoice`, {
            invoice_reference: "INV-2026-001",
        });
        expect(orderSchema.parse(await invoiced.json()).invoice_reference).toBe("INV-2026-001");
        const placed = orderSchema.parse(
            await (await send(token, "POST", `orders/${order.id}/place`)).json(),
        );
        expect(placed.state).toBe("placed");
        expect(placed.delivery?.state).toBe("pending");
        expect(placed.payment_status).toBe("unpaid");
        const paid = orderSchema.parse(
            await (await send(token, "POST", `orders/${order.id}/paid`)).json(),
        );
        expect(paid.payment_status).toBe("paid");
        expect((await send(token, "POST", `orders/${order.id}/paid`)).status).toBe(404);
        const jobs = await h.db.database.sql`select id from jobs where kind = 'delivery.watermark'`;
        expect(jobs.length).toBeGreaterThanOrEqual(1);
        const listed = ordersResponseSchema.parse(
            await (await send(token, "GET", "orders")).json(),
        );
        expect(listed.orders.some((o) => o.id === order.id && o.item_count === 1)).toBe(true);
        const actions = await h.db.database.sql<
            { action: string }[]
        >`select action from audit_log where action like 'order.%' order by seq`;
        expect(actions.map((a) => a.action)).toEqual(
            expect.arrayContaining([
                "order.created",
                "order.item_added",
                "order.invoice_set",
                "order.placed",
            ]),
        );
    });

    it("refuses a draft version, an empty placement and changes after placement", async () => {
        const { token } = await h.login(ALICE);
        const order = await draftOrder(token);
        const draft = await send(token, "POST", `orders/${order.id}/items`, {
            task_version_id: encodeId("tsv", draftVersion),
        });
        expect(draft.status).toBe(409);
        expect((await send(token, "POST", `orders/${order.id}/place`)).status).toBe(409);
        await send(token, "POST", `orders/${order.id}/items`, {
            task_version_id: encodeId("tsv", releasedVersion),
        });
        expect((await send(token, "POST", `orders/${order.id}/place`)).status).toBe(200);
        expect((await send(token, "POST", `orders/${order.id}/place`)).status).toBe(404);
        expect((await send(token, "POST", `orders/${order.id}/cancel`)).status).toBe(404);
        const again = await send(token, "POST", `orders/${order.id}/items`, {
            task_version_id: encodeId("tsv", releasedVersion),
        });
        expect([404, 409]).toContain(again.status);
    });
});

describe("deliveries and cancellation", () => {
    it("revokes a delivery and records it", async () => {
        const { token } = await h.login(ALICE);
        const order = await draftOrder(token);
        await send(token, "POST", `orders/${order.id}/items`, {
            task_version_id: encodeId("tsv", releasedVersion),
        });
        const placed = orderSchema.parse(
            await (await send(token, "POST", `orders/${order.id}/place`)).json(),
        );
        const deliveryId = placed.delivery?.id ?? "";
        const revoked = await send(token, "POST", `deliveries/${deliveryId}/revoke`, {
            reason: "contract ended",
        });
        expect(revoked.status).toBe(204);
        const after = orderSchema.parse(
            await (await send(token, "GET", `orders/${order.id}`)).json(),
        );
        expect(after.delivery?.state).toBe("revoked");
        expect(
            (await send(token, "POST", `deliveries/${deliveryId}/revoke`, { reason: "again" }))
                .status,
        ).toBe(404);
    });

    it("cancels a draft", async () => {
        const { token } = await h.login(ALICE);
        const order = await draftOrder(token);
        const cancelled = await send(token, "POST", `orders/${order.id}/cancel`);
        expect(orderSchema.parse(await cancelled.json()).state).toBe("cancelled");
    });
});

describe("access", () => {
    it("shows the routes to platform administrators only, and asks for a fresh passkey check", async () => {
        const anonymous = await send(null, "GET", "orders");
        expect(anonymous.status).toBe(401);
        const bob = await h.login(BOB);
        expect((await send(bob.token, "GET", "orders")).status).toBe(404);
        expect((await send(bob.token, "POST", "orders", orderRequest())).status).toBe(404);
        const alice = await h.login(ALICE);
        h.clock.advance(16 * 60 * 1000);
        expect((await send(alice.token, "POST", "orders", orderRequest())).status).toBe(403);
    });

    it("rejects unknown fields, bad ids and customers that are not companies or labs", async () => {
        const { token } = await h.login(ALICE);
        const bad = await send(token, "POST", "orders", { ...orderRequest(), extra: 1 });
        expect(bad.status).toBe(400);
        const days = await send(token, "POST", "orders", { ...orderRequest(), delivery_days: 0 });
        expect(days.status).toBe(400);
        expect((await send(token, "GET", "orders/not-an-id")).status).toBe(404);
        const [community] = await h.db.database.sql<
            { id: string }[]
        >`insert into orgs (kind, slug, name) values ('community', 'club', 'Club') returning id`;
        const notCustomer = await send(token, "POST", "orders", {
            ...orderRequest(),
            customer_org_id: encodeId("org", community?.id ?? ""),
        });
        expect(notCustomer.status).toBe(409);
    });
});
