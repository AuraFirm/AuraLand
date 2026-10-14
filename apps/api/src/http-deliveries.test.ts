// Goal: a customer's buyers see their own deliveries and fetch each bundle through a short-lived link,
// and nothing else: other customers get 404, pending, revoked and expired deliveries issue no link,
// every issued link has a log row (and a refused one has none), the link goes only to a bundle that
// is in the delivery, and the number of links per minute is limited.
import { createHash } from "node:crypto";
import {
    deliveriesResponseSchema,
    deliverySchema,
    downloadSchema,
} from "@aura/contracts/api/deliveries";
import { orderSchema } from "@aura/contracts/api/orders";
import { encodeId } from "@aura/contracts/ids";
import { withRequestContext } from "@aura/db/context";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plantDelivered } from "./delivery-test-support.ts";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { SPEC } from "./http-task-support.ts";
import { buildDelivery } from "./modules/orders/handlers.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;

let h: Harness;
let seller = "";
let customer = "";
let version = "";
let otherVersion = "";
beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`update users set platform_role = 'admin' where id = ${ALICE}`;
    await sql`insert into users (id, email, email_verified_at) values (${CAROL}, 'carol@example.com', now())`;
    const [s] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'seller-co', 'S') returning id`;
    const [c] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('ai_lab', 'customer-lab', 'L') returning id`;
    seller = s?.id ?? "";
    customer = c?.id ?? "";
    await sql`insert into memberships (org_id, user_id, role) values (${customer}, ${BOB}, 'buyer')`;
    const taskFor = async (slug: string) => {
        const [task] = await sql<
            { id: string }[]
        >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
            values (${seller}, ${slug}, 'algorithmic', 'private', 'T', ${CAROL}) returning id`;
        return task?.id ?? "";
    };
    const [taskOne, taskTwo] = [await taskFor("sold-one"), await taskFor("sold-two")];
    await sql`alter table task_versions disable trigger task_versions_guard`;
    const planted = async (taskId: string, content: string) => {
        const hash = createHash("sha256").update(content).digest();
        const [row] = await sql<{ id: string }[]>`insert into task_versions
            (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
            values (${seller}, ${taskId}, 1, 'released', ${sql.json(SPEC)}, 'Add.', ${content.length}, ${hash}, ${CAROL}, ${ALICE}, now(), true, now())
            returning id`;
        return row?.id ?? "";
    };
    version = await planted(taskOne, "bundle-one");
    otherVersion = await planted(taskTwo, "bundle-two");
    await sql`alter table task_versions enable trigger task_versions_guard`;
});
afterAll(async () => {
    await h.drop();
});

const as = async (userId: string, method: string, path: string, body?: unknown) => {
    const { token } = await h.login(userId);
    return h.request(path, {
        method,
        headers: browser(token, body === undefined ? {} : { "content-type": "application/json" }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
};

// An order with one version, placed by the platform administrator and (optionally) built by the worker.
async function delivery(
    build = true,
    marked: ReadonlyMap<string, Buffer> = new Map(),
): Promise<string> {
    const created = await as(ALICE, "POST", "/admin/orders", {
        customer_org_id: encodeId("org", customer),
        title: "Pack",
        licence_terms: "Internal use.",
        delivery_days: 30,
    });
    const order = orderSchema.parse(await created.json());
    await as(ALICE, "POST", `/admin/orders/${order.id}/items`, {
        task_version_id: encodeId("tsv", version),
    });
    const placed = orderSchema.parse(
        await (await as(ALICE, "POST", `/admin/orders/${order.id}/place`)).json(),
    );
    const id = placed.delivery?.id ?? "";
    if (build) {
        const raw = id.slice("dlv_".length);
        await plantDelivered(h.db.database.sql, raw, marked);
        await buildDelivery(
            { delivery_id: raw },
            {
                clock: h.clock,
                inTransaction: (work) => withRequestContext(h.db.database.sql, WORKER, work),
            },
        );
    }
    return id;
}

const link = (id: string, versionId = version, userId = BOB) =>
    as(userId, "POST", `/deliveries/${id}/downloads`, {
        task_version_id: encodeId("tsv", versionId),
    });
const logRows = async () => (await h.db.database.sql`select id from delivery_access`).length;

describe("reading deliveries", () => {
    it("shows a built delivery with its manifest and hash to the customer's buyer only", async () => {
        const id = await delivery();
        const read = deliverySchema.parse(await (await as(BOB, "GET", `/deliveries/${id}`)).json());
        expect(read.status).toBe("ready");
        expect(read.items?.length).toBe(1);
        expect(read.manifest_sha256).toBe(
            createHash("sha256")
                .update(read.manifest ?? "")
                .digest("hex"),
        );
        expect(read.items?.[0]?.validation).toMatch(/not performed/);
        const listed = deliveriesResponseSchema.parse(
            await (await as(BOB, "GET", "/deliveries")).json(),
        );
        expect(listed.deliveries.some((d) => d.id === id && d.manifest === null)).toBe(true);
        expect((await as(CAROL, "GET", `/deliveries/${id}`)).status).toBe(404);
        const carolList = deliveriesResponseSchema.parse(
            await (await as(CAROL, "GET", "/deliveries")).json(),
        );
        expect(carolList.deliveries.length).toBe(0);
    });

    it("tells a customer that a delivery is pending until the worker has built it", async () => {
        const id = await delivery(false);
        const read = deliverySchema.parse(await (await as(BOB, "GET", `/deliveries/${id}`)).json());
        expect(read.status).toBe("pending");
        expect(read.manifest).toBeNull();
        expect((await link(id)).status).toBe(409);
    });
});

describe("download links", () => {
    it("points a marked bundle's link at the delivery's own copy and never at the original", async () => {
        const copy = new TextEncoder().encode("bundle-one, marked for this delivery");
        const copySha = createHash("sha256").update(copy).digest();
        const id = await delivery(true, new Map([[version, copySha]]));
        const issued = downloadSchema.parse(await (await link(id)).json());
        const [row] = await h.db.database.sql<
            { customer_org_id: string }[]
        >`select customer_org_id from deliveries where id = ${id.slice("dlv_".length)}`;
        h.storage.write(
            `bundles/${seller}/${createHash("sha256").update("bundle-one").digest("hex")}`,
            new TextEncoder().encode("bundle-one"),
        );
        expect(h.storage.fetchDownload(issued.url)).toBeUndefined(); // the original is not what the link names
        h.storage.write(
            `deliveries/${row?.customer_org_id}/${id.slice("dlv_".length)}/${copySha.toString("hex")}`,
            copy,
        );
        const again = downloadSchema.parse(await (await link(id)).json());
        expect(new TextDecoder().decode(h.storage.fetchDownload(again.url))).toBe(
            "bundle-one, marked for this delivery",
        );
    });

    it("issues a short-lived link for a bundle in the delivery, and logs it", async () => {
        const id = await delivery();
        const before = await logRows();
        const response = await link(id);
        expect(response.status).toBe(200);
        const issued = downloadSchema.parse(await response.json());
        expect(issued.expires_in_s).toBe(300);
        // The link leads to exactly the delivered bundle, and stops working when it expires.
        const key = `bundles/${seller}/${createHash("sha256").update("bundle-one").digest("hex")}`;
        h.storage.write(key, new TextEncoder().encode("bundle-one"));
        expect(new TextDecoder().decode(h.storage.fetchDownload(issued.url))).toBe("bundle-one");
        h.clock.advance(301_000);
        expect(h.storage.fetchDownload(issued.url)).toBeUndefined();
        expect(await logRows()).toBe(before + 1);
    });
});

describe("download links, refusals", () => {
    it("refuses another customer, an unknown version and a version that is not in the delivery", async () => {
        const id = await delivery();
        const before = await logRows();
        expect((await link(id, version, CAROL)).status).toBe(404);
        expect((await link(id, otherVersion)).status).toBe(404);
        expect((await link(id, "018f0000-0000-7000-8000-0000000000ee")).status).toBe(404);
        expect(await logRows()).toBe(before);
    });

    it("refuses a revoked and an expired delivery and logs nothing", async () => {
        const revoked = await delivery();
        await as(ALICE, "POST", `/admin/deliveries/${revoked}/revoke`, {
            reason: "contract ended",
        });
        const expired = await delivery();
        const before = await logRows();
        expect((await link(revoked)).status).toBe(409);
        h.clock.advance(31 * 24 * 3600 * 1000);
        expect((await link(expired)).status).toBe(409);
        const read = deliverySchema.parse(
            await (await as(BOB, "GET", `/deliveries/${expired}`)).json(),
        );
        expect(read.status).toBe("expired");
        expect(await logRows()).toBe(before);
    });

    it("limits links per minute and rejects unknown fields", async () => {
        const id = await delivery();
        expect(
            (
                await as(BOB, "POST", `/deliveries/${id}/downloads`, {
                    task_version_id: encodeId("tsv", version),
                    x: 1,
                })
            ).status,
        ).toBe(400);
        h.clock.advance(61_000);
        const statuses: number[] = [];
        for (let attempt = 0; attempt < 31; attempt++) statuses.push((await link(id)).status);
        expect(statuses.filter((status) => status === 200).length).toBe(30);
        expect(statuses[30]).toBe(429);
    });
});
