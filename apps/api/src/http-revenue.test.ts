// Goal: setter revenue share through the real HTTP app and PostgreSQL. Booking an order item's revenue is one balanced ledger
// transaction (cash in = platform share + setters' shares, rounding going to the platform), once only; shares on a task cannot pass
// 100%; a payout batch reserves exactly what is available, cannot be paid twice, and posting it zeroes what the setter is owed; a
// cancelled batch frees the reservation; only platform administrators (fresh passkey check) do any of it, and a setter sees only
// their own position.
import { createHash } from "node:crypto";
import { batchSchema, earningsResponseSchema } from "@aura/contracts/api/revenue";
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3"; // setter, 30%
const DAVE = "018f0000-0000-7000-8000-0000000000d4"; // setter, 20%
let h: Harness;
let task = "";
let version = "";
let order = "";

beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    await sql`update users set platform_role = 'admin' where id = ${ALICE}`;
    for (const [id, name] of [
        [CAROL, "carol"],
        [DAVE, "dave"],
    ] as const)
        await sql`insert into users (id, email, email_verified_at) values (${id}, ${`${name}@example.com`}, now())`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'rev-co', 'R') returning id`;
    const [t] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${org?.id ?? ""}, 'rev-task', 'algorithmic', 'private', 'T', ${CAROL}) returning id`;
    task = t?.id ?? "";
    await sql.begin(async (tx) => {
        await tx`alter table task_versions disable trigger task_versions_guard`;
        const [row] = await tx<{ id: string }[]>`insert into task_versions
            (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
            values (${org?.id ?? ""}, ${task}, 1, 'released', '{}'::jsonb, 'S', 6, ${createHash("sha256").update("b").digest()}, ${CAROL}, ${DAVE}, now(), true, now())
            returning id`;
        version = row?.id ?? "";
        await tx`alter table task_versions enable trigger task_versions_guard`;
    });
    const [o] = await sql<
        { id: string }[]
    >`insert into orders (customer_org_id, title, licence_terms, delivery_days, created_by, created_at, updated_at)
        values (${org?.id ?? ""}, 'O', 'terms', 7, ${ALICE}, now(), now()) returning id`;
    order = o?.id ?? "";
    await sql`insert into order_items (order_id, task_version_id, task_org_id, added_at) values (${order}, ${version}, ${org?.id ?? ""}, now())`;
    await sql`update orders set state = 'placed', placed_at = now() where id = ${order}`;
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
const terms = (user: string, bps: number) =>
    call(ALICE, "PUT", `/admin/tasks/${encodeId("tsk", task)}/setter-terms`, {
        user_id: encodeId("usr", user),
        share_bps: bps,
    });
const book = (amount: number) =>
    call(ALICE, "POST", `/admin/orders/${encodeId("ord", order)}/revenue`, {
        task_version_id: encodeId("tsv", version),
        amount_minor: amount,
        currency: "USD",
    });
const owed = async (user: string) =>
    Number((await h.db.database.sql`select setter_owed(${user}, 'USD') as v`)[0]?.["v"]);

describe("terms and booking", () => {
    it("lets shares add up to 100% and no more", async () => {
        expect((await terms(CAROL, 3000)).status).toBe(204);
        expect((await terms(DAVE, 2000)).status).toBe(204);
        expect((await terms(DAVE, 7001)).status).toBe(400);
        expect((await terms(DAVE, 7000)).status).toBe(204);
        expect((await terms(DAVE, 2000)).status).toBe(204);
        expect((await terms(CAROL, 0)).status).toBe(400);
    });

    it("splits revenue into one balanced ledger transaction, rounding to the platform, and only once", async () => {
        expect((await book(1001)).status).toBe(201); // carol 300, dave 200 (floors of 300.3 and 200.2), platform 501
        expect(await owed(CAROL)).toBe(300);
        expect(await owed(DAVE)).toBe(200);
        const entries = await h.db.database
            .sql`select account, direction, amount_minor::int as a from ledger_entries order by account, direction`;
        expect(entries.map((e) => `${e["account"]}:${e["direction"]}:${e["a"]}`)).toEqual([
            `cash:D:1001`,
            `payable_setter:${CAROL}:C:300`,
            `payable_setter:${DAVE}:C:200`,
            `revenue:C:501`,
        ]);
        expect((await book(1001)).status).toBe(409);
    });

    it("refuses an order that is not placed, an item that is not in it, and bad amounts", async () => {
        for (const amount of [0, -1, 1.5]) expect((await book(amount)).status).toBe(400);
        const other = await call(ALICE, "POST", `/admin/orders/${encodeId("ord", order)}/revenue`, {
            task_version_id: encodeId("tsv", "018f0000-0000-7000-8000-00000000beef"),
            amount_minor: 5,
            currency: "USD",
        });
        expect(other.status).toBe(404);
    });
});

describe("payout batches", () => {
    let batch = "";
    it("reserve exactly what is available and no more", async () => {
        const made = await call(ALICE, "POST", "/admin/payout-batches", { currency: "USD" });
        expect(made.status).toBe(201);
        const parsed = batchSchema.parse(await made.json());
        batch = parsed.id;
        expect(parsed).toMatchObject({ state: "created", total_minor: 500, lines: 2 });
        // Everything is reserved now, so a second batch has nobody to pay.
        expect(
            (await call(ALICE, "POST", "/admin/payout-batches", { currency: "USD" })).status,
        ).toBe(404);
        expect((await call(CAROL, "GET", "/me/earnings")).status).toBe(200);
        const carol = earningsResponseSchema.parse(
            await (await call(CAROL, "GET", "/me/earnings")).json(),
        );
        expect(carol.balances).toEqual([{ currency: "USD", owed_minor: 300, available_minor: 0 }]);
    });

    it("free the reservation when cancelled, then pay once when marked paid", async () => {
        expect((await call(ALICE, "POST", `/admin/payout-batches/${batch}/cancel`)).status).toBe(
            204,
        );
        expect((await call(ALICE, "POST", `/admin/payout-batches/${batch}/cancel`)).status).toBe(
            404,
        );
        const again = batchSchema.parse(
            await (
                await call(ALICE, "POST", "/admin/payout-batches", {
                    currency: "USD",
                    minimum_minor: 250,
                })
            ).json(),
        );
        expect(again).toMatchObject({ total_minor: 300, lines: 1 }); // only carol is owed at least 250
        const paid = await call(ALICE, "POST", `/admin/payout-batches/${again.id}/paid`, {
            reference: "wire-1",
        });
        expect(batchSchema.parse(await paid.json()).state).toBe("paid");
        expect(
            (
                await call(ALICE, "POST", `/admin/payout-batches/${again.id}/paid`, {
                    reference: "wire-2",
                })
            ).status,
        ).toBe(409);
        expect(await owed(CAROL)).toBe(0);
        expect(await owed(DAVE)).toBe(200);
        const [cash] = await h.db.database
            .sql`select sum(case direction when 'D' then amount_minor else -amount_minor end)::int as net from ledger_entries where account = 'cash'`;
        expect(cash?.["net"]).toBe(701);
    });
});

describe("who may", () => {
    it("is for platform administrators only, and a setter sees only their own position", async () => {
        for (const [method, path, body] of [
            [
                "PUT",
                `/admin/tasks/${encodeId("tsk", task)}/setter-terms`,
                { user_id: encodeId("usr", BOB), share_bps: 100 },
            ],
            [
                "POST",
                `/admin/orders/${encodeId("ord", order)}/revenue`,
                { task_version_id: encodeId("tsv", version), amount_minor: 5, currency: "USD" },
            ],
            ["POST", "/admin/payout-batches", { currency: "USD" }],
            ["GET", "/admin/payout-batches", undefined],
        ] as const)
            expect((await call(BOB, method, path, body)).status, path).toBe(404);
        const dave = earningsResponseSchema.parse(
            await (await call(DAVE, "GET", "/me/earnings")).json(),
        );
        expect(dave.balances).toEqual([{ currency: "USD", owed_minor: 200, available_minor: 200 }]);
        expect(
            earningsResponseSchema.parse(await (await call(BOB, "GET", "/me/earnings")).json())
                .balances,
        ).toEqual([]);
    });
});
