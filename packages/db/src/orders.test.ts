// Goal: orders and deliveries enforce their own rules in the database (migration 0020). Only a platform
// administrator writes (through functions that check the role); a customer sees only its own
// organization's rows; an order holds released versions and freezes when placed; a delivery's manifest is
// set once and must hash to its stored value; the download log is append-only. Setup runs as the
// database owner; every behaviour under test runs as the application role with a real context.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const U = (n: number) => `018f0000-0000-7000-8000-00000000020${n}`;
const ADMIN = U(1);
const BUYER = U(2);
const CUSTOMER_OWNER = U(3);
const OTHER_BUYER = U(4);
const SETTER = U(5);
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);
const NOW = new Date("2026-10-12T10:00:00Z");

let db: TestDatabase;
let seller = "";
let customer = "";
let rival = "";
let draftVersion = "";
let releasedVersion = "";
beforeAll(async () => {
    db = await createMigratedTestDatabase(8);
    const { sql } = db.database;
    for (const n of [1, 2, 3, 4, 5])
        await sql`insert into users (id, email) values (${U(n)}, ${`order${n}@example.com`})`;
    await sql`update users set platform_role = 'admin' where id = ${ADMIN}`;
    seller = await newOrg("seller-team", "company");
    customer = await newOrg("customer-lab", "ai_lab");
    rival = await newOrg("rival-lab", "company");
    await sql`insert into memberships (org_id, user_id, role) values
        (${customer}, ${BUYER}, 'buyer'), (${customer}, ${CUSTOMER_OWNER}, 'owner'),
        (${rival}, ${OTHER_BUYER}, 'buyer'), (${seller}, ${SETTER}, 'setter')`;
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${seller}, 'sold-task', 'algorithmic', 'private', 'T', ${SETTER}) returning id`;
    const taskId = task?.id ?? "";
    // The version state machine is tested elsewhere; here a released row is planted with the guard off.
    await sql`alter table task_versions disable trigger task_versions_guard`;
    const hash = createHash("sha256").update("bundle").digest();
    const [released] = await sql<{ id: string }[]>`insert into task_versions
        (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
        values (${seller}, ${taskId}, 1, 'released', '{}'::jsonb, 'S', 6, ${hash}, ${SETTER}, ${ADMIN}, now(), true, now())
        returning id`;
    releasedVersion = released?.id ?? "";
    const [draft] = await sql<
        { id: string }[]
    >`insert into task_versions (org_id, task_id, seq, created_by)
        values (${seller}, ${taskId}, 2, ${SETTER}) returning id`;
    draftVersion = draft?.id ?? "";
    await sql`alter table task_versions enable trigger task_versions_guard`;
});
afterAll(async () => {
    await db.drop();
});

async function newOrg(slug: string, kind: string): Promise<string> {
    const [row] = await db.database.sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values (${kind}, ${slug}, 'x') returning id`;
    return row?.id ?? "";
}
const run = <T>(userId: string, work: Parameters<typeof inRole<T>>[3]) =>
    inRole(db.database, "aura_app", as(userId), work);
const watermark = () => randomBytes(16).toString("hex");

async function newOrder(forOrg = customer): Promise<string> {
    const rows = await run(
        ADMIN,
        (tx) =>
            tx<
                { id: string }[]
            >`select create_order(${forOrg}, 'Pack', 'Licence text', 30, ${NOW}) as id`,
    );
    return rows[0]?.id ?? "";
}
const addItem = (order: string, version: string, userId = ADMIN) =>
    run(userId, (tx) => tx`select add_order_item(${order}, ${version}, ${NOW})`);
const place = (order: string, userId = ADMIN) =>
    run(
        userId,
        (tx) => tx<{ id: string }[]>`select place_order(${order}, ${watermark()}, ${NOW}) as id`,
    );

describe("who may write", () => {
    it("lets only a platform administrator use the order functions", async () => {
        for (const userId of [BUYER, CUSTOMER_OWNER, SETTER]) {
            await fails(
                run(userId, (tx) => tx`select create_order(${customer}, 'x', 'y', 30, ${NOW})`),
                /only a platform administrator/,
            );
        }
        const order = await newOrder();
        await fails(addItem(order, releasedVersion, BUYER), /only a platform administrator/);
        await fails(place(order, CUSTOMER_OWNER), /only a platform administrator/);
    });

    it("gives the application role no direct write on any of the four tables", async () => {
        const order = await newOrder();
        for (const statement of [
            (tx: Parameters<Parameters<typeof run>[1]>[0]) =>
                tx`insert into orders (customer_org_id, title, licence_terms, delivery_days, created_by, created_at, updated_at)
                    values (${customer}, 't', 'l', 1, ${ADMIN}, now(), now())`,
            (tx: Parameters<Parameters<typeof run>[1]>[0]) =>
                tx`update orders set title = 'z' where id = ${order}`,
            (tx: Parameters<Parameters<typeof run>[1]>[0]) =>
                tx`insert into order_items (order_id, task_version_id, task_org_id, added_at)
                    values (${order}, ${releasedVersion}, ${seller}, now())`,
            (tx: Parameters<Parameters<typeof run>[1]>[0]) => tx`delete from deliveries`,
            (tx: Parameters<Parameters<typeof run>[1]>[0]) => tx`delete from delivery_access`,
        ]) {
            await fails(run(ADMIN, statement), /permission denied/);
        }
    });
});

describe("orders", () => {
    it("sells only to companies and AI labs", async () => {
        const personal = await newOrg("not-a-customer", "community");
        await fails(newOrder(personal), /company or an AI lab/);
    });

    it("accepts released versions only, once each", async () => {
        const order = await newOrder();
        await fails(addItem(order, draftVersion), /only a released version/);
        await addItem(order, releasedVersion);
        await fails(addItem(order, releasedVersion), /order_items_pkey|duplicate/);
    });

    it("refuses an empty order, freezes a placed one and refuses a second placement", async () => {
        const empty = await newOrder();
        await fails(place(empty), /at least one version/);
        const order = await newOrder();
        await addItem(order, releasedVersion);
        await place(order);
        await fails(addItem(order, releasedVersion), /no such|only a draft order/);
        await fails(place(order), /no such draft order/);
        await fails(
            db.database.sql`update orders set title = 'changed' where id = ${order}`,
            /does not change/,
        );
        await fails(
            run(ADMIN, (tx) => tx`select cancel_order(${order}, ${NOW})`),
            /no such draft order/,
        );
    });

    it("still takes an invoice reference after placement", async () => {
        const order = await newOrder();
        await addItem(order, releasedVersion);
        await place(order);
        await run(ADMIN, (tx) => tx`select set_order_invoice(${order}, 'INV-1', ${NOW})`);
        const rows = await run(
            CUSTOMER_OWNER,
            (tx) =>
                tx<
                    { invoice_reference: string }[]
                >`select invoice_reference from orders where id = ${order}`,
        );
        expect(rows[0]?.invoice_reference).toBe("INV-1");
    });
});

describe("visibility", () => {
    it("shows an order to its customer's buyers and owners, the platform administrator, and nobody else", async () => {
        const order = await newOrder();
        await addItem(order, releasedVersion);
        const count = async (userId: string) =>
            (await run(userId, (tx) => tx`select id from orders where id = ${order}`)).length;
        expect(await count(ADMIN)).toBe(1);
        expect(await count(BUYER)).toBe(1);
        expect(await count(CUSTOMER_OWNER)).toBe(1);
        expect(await count(OTHER_BUYER)).toBe(0);
        expect(await count(SETTER)).toBe(0);
        const items = async (userId: string) =>
            (
                await run(
                    userId,
                    (tx) => tx`select order_id from order_items where order_id = ${order}`,
                )
            ).length;
        expect(await items(BUYER)).toBe(1);
        expect(await items(OTHER_BUYER)).toBe(0);
    });

    it("hides a customer's delivery and download log from other customers", async () => {
        const order = await newOrder();
        await addItem(order, releasedVersion);
        const deliveryId = (await place(order))[0]?.id ?? "";
        const seen = (userId: string) =>
            run(userId, (tx) => tx`select id from deliveries where id = ${deliveryId}`);
        expect((await seen(BUYER)).length).toBe(1);
        expect((await seen(OTHER_BUYER)).length).toBe(0);
        expect((await seen(SETTER)).length).toBe(0);
    });

    it("does not let a buyer read the seller's task versions", async () => {
        const rows = await run(BUYER, (tx) => tx`select id from task_versions`);
        expect(rows.length).toBe(0);
    });
});

async function pendingDelivery(): Promise<string> {
    const order = await newOrder();
    await addItem(order, releasedVersion);
    return (await place(order))[0]?.id ?? "";
}

describe("deliveries", () => {
    const manifest = '{"items":[]}';
    const digest = (text: string) => createHash("sha256").update(text).digest();

    it("creates a pending delivery with an expiry and a build job in the same step", async () => {
        const id = await pendingDelivery();
        const { sql } = db.database;
        const [row] = await sql<
            { state: string; expires_at: Date }[]
        >`select state, expires_at from deliveries where id = ${id}`;
        expect(row?.state).toBe("pending");
        expect(row?.expires_at.toISOString()).toBe("2026-11-11T10:00:00.000Z");
        const jobs =
            await sql`select id from jobs where kind = 'delivery.build' and payload->>'delivery_id' = ${id}`;
        expect(jobs.length).toBe(1);
    });

    it("sets the manifest once, only with its true hash", async () => {
        const id = await pendingDelivery();
        const { sql } = db.database;
        await fails(
            sql`update deliveries set state = 'ready', ready_at = now(), manifest = ${manifest}, manifest_sha256 = ${digest("other")} where id = ${id}`,
            /hash does not match/,
        );
        await sql`update deliveries set state = 'ready', ready_at = now(), manifest = ${manifest}, manifest_sha256 = ${digest(manifest)} where id = ${id}`;
        await fails(
            sql`update deliveries set manifest = '{"items":[1]}', manifest_sha256 = ${digest('{"items":[1]}')} where id = ${id}`,
            /set once/,
        );
        await fails(
            sql`update deliveries set watermark_id = ${watermark()} where id = ${id}`,
            /keeps its order/,
        );
        await fails(
            sql`update deliveries set expires_at = now() + interval '9 years' where id = ${id}`,
            /keeps its order/,
        );
    });

    it("revokes from pending or ready and never leaves revoked", async () => {
        const id = await pendingDelivery();
        await run(ADMIN, (tx) => tx`select revoke_delivery(${id}, 'contract ended', ${NOW})`);
        await fails(
            run(ADMIN, (tx) => tx`select revoke_delivery(${id}, 'again', ${NOW})`),
            /no such active delivery/,
        );
        await fails(
            db.database
                .sql`update deliveries set state = 'ready', revoked_at = null, ready_at = now() where id = ${id}`,
            /revoked delivery does not change/,
        );
        await fails(
            run(BUYER, (tx) => tx`select revoke_delivery(${id}, 'x', ${NOW})`),
            /only a platform administrator/,
        );
    });
});

describe("download log", () => {
    it("keeps the download log append-only", async () => {
        const id = await pendingDelivery();
        const { sql } = db.database;
        await sql`insert into delivery_access (delivery_id, customer_org_id, user_id, task_version_id, issued_at, link_expires_at)
            values (${id}, ${customer}, ${BUYER}, ${releasedVersion}, ${NOW}, ${new Date(NOW.getTime() + 300000)})`;
        await fails(sql`delete from delivery_access`, /append-only/);
        await fails(sql`update delivery_access set user_id = ${ADMIN}`, /append-only/);
        await fails(
            sql`insert into delivery_access (delivery_id, customer_org_id, user_id, task_version_id, issued_at, link_expires_at)
                values (${id}, ${customer}, ${BUYER}, ${releasedVersion}, ${NOW}, ${new Date(NOW.getTime() + 7200000)})`,
            /delivery_access_window/,
        );
        const asBuyer = await run(BUYER, (tx) => tx`select id from delivery_access`);
        expect(asBuyer.length).toBe(0); // buyers do not see the log, owners and admins do
        const asOwner = await run(CUSTOMER_OWNER, (tx) => tx`select id from delivery_access`);
        expect(asOwner.length).toBe(1);
    });
});
