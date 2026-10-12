// Goal: payment records cannot be rewritten (migration 0023). An order is marked paid once and only
// after it is placed; a payout is for the author of a released version, its agreement never changes,
// it is paid at most once, never deleted, and only the contractor and platform administrators read it.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "./context.ts";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "./test-helpers.ts";

const U = (n: number) => `018f0000-0000-7000-8000-00000000030${n}`;
const ADMIN = U(1);
const AUTHOR = U(2);
const OTHER = U(3);
const REVIEWER = U(4);
const as = (userId: string): RequestContext => ({ actorKind: "user", userId, orgIds: [] });
const fails = (promise: Promise<unknown>, pattern: RegExp) =>
    expect(promise).rejects.toThrow(pattern);
const NOW = new Date("2026-10-12T10:00:00Z");

let db: TestDatabase;
let version = "";
let customer = "";
beforeAll(async () => {
    db = await createMigratedTestDatabase(6);
    const { sql } = db.database;
    for (const n of [1, 2, 3, 4])
        await sql`insert into users (id, email) values (${U(n)}, ${`pay${n}@example.com`})`;
    await sql`update users set platform_role = 'admin' where id = ${ADMIN}`;
    const [seller] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'pay-seller', 'S') returning id`;
    const [buyer] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('ai_lab', 'pay-buyer', 'B') returning id`;
    customer = buyer?.id ?? "";
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
        values (${seller?.id ?? ""}, 'paid-task', 'algorithmic', 'private', 'T', ${AUTHOR}) returning id`;
    await sql.begin(async (tx) => {
        await tx`alter table task_versions disable trigger task_versions_guard`;
        const [row] = await tx<{ id: string }[]>`insert into task_versions
            (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
            values (${seller?.id ?? ""}, ${task?.id ?? ""}, 1, 'released', '{}'::jsonb, 'S', 6, ${createHash("sha256").update("b").digest()}, ${AUTHOR}, ${REVIEWER}, now(), true, now())
            returning id`;
        version = row?.id ?? "";
        await tx`alter table task_versions enable trigger task_versions_guard`;
    });
});
afterAll(async () => {
    await db.drop();
});

const run = <T>(userId: string, work: Parameters<typeof inRole<T>>[3]) =>
    inRole(db.database, "aura_app", as(userId), work);
const record = async (contractor = AUTHOR, amount = 5000) =>
    (
        await run(
            ADMIN,
            (tx) =>
                tx<
                    { id: string }[]
                >`select record_payout(${contractor}, ${version}, ${amount}, 'USD', ${NOW}) as id`,
        )
    )[0]?.id ?? "";

describe("order payment", () => {
    it("is recorded once, and only for a placed order", async () => {
        const [order] = await run(
            ADMIN,
            (tx) =>
                tx<{ id: string }[]>`select create_order(${customer}, 'T', 'L', 30, ${NOW}) as id`,
        );
        const id = order?.id ?? "";
        await fails(
            run(ADMIN, (tx) => tx`select mark_order_paid(${id}, ${NOW})`),
            /no such unpaid placed order/,
        );
        await run(ADMIN, (tx) => tx`select add_order_item(${id}, ${version}, ${NOW})`);
        await run(ADMIN, (tx) => tx`select place_order(${id}, ${"a".repeat(32)}, ${NOW})`);
        await fails(
            run(AUTHOR, (tx) => tx`select mark_order_paid(${id}, ${NOW})`),
            /only a platform administrator/,
        );
        await run(ADMIN, (tx) => tx`select mark_order_paid(${id}, ${NOW})`);
        await fails(
            run(ADMIN, (tx) => tx`select mark_order_paid(${id}, ${NOW})`),
            /no such unpaid placed order/,
        );
        await fails(
            db.database.sql`update orders set paid_at = null where id = ${id}`,
            /recorded once/,
        );
    });
});

describe("contractor payouts", () => {
    it("are for the author of a released version, by a platform administrator only", async () => {
        await fails(record(OTHER), /author of a released version/);
        await fails(
            run(
                AUTHOR,
                (tx) => tx`select record_payout(${AUTHOR}, ${version}, 100, 'USD', ${NOW})`,
            ),
            /only a platform administrator/,
        );
        await fails(
            run(ADMIN, (tx) => tx`select record_payout(${AUTHOR}, ${version}, 0, 'USD', ${NOW})`),
            /payouts_amount/,
        );
        await fails(
            run(ADMIN, (tx) => tx`select record_payout(${AUTHOR}, ${version}, 100, 'usd', ${NOW})`),
            /payouts_currency/,
        );
        expect((await record()).length).toBeGreaterThan(0);
    });

    it("keep their agreement, are paid at most once and are never deleted", async () => {
        const id = await record();
        const { sql } = db.database;
        await fails(
            sql`update contractor_payouts set amount_minor = 9 where id = ${id}`,
            /agreement/,
        );
        await run(ADMIN, (tx) => tx`select mark_payout_paid(${id}, 'wire-1', ${NOW})`);
        await fails(
            run(ADMIN, (tx) => tx`select mark_payout_paid(${id}, 'wire-2', ${NOW})`),
            /no such unpaid payout/,
        );
        await fails(
            sql`update contractor_payouts set paid_reference = 'x' where id = ${id}`,
            /does not change/,
        );
        await fails(sql`delete from contractor_payouts where id = ${id}`, /never deleted/);
        await fails(
            run(ADMIN, (tx) => tx`delete from contractor_payouts`),
            /permission denied/,
        );
    });

    it("are read by the contractor and platform administrators only", async () => {
        const id = await record();
        const count = async (userId: string) =>
            (await run(userId, (tx) => tx`select id from contractor_payouts where id = ${id}`))
                .length;
        expect(await count(AUTHOR)).toBe(1);
        expect(await count(ADMIN)).toBe(1);
        expect(await count(OTHER)).toBe(0);
        expect(await count(REVIEWER)).toBe(0);
    });
});
