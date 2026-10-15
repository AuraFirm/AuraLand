// Goal: the ledger cannot hold a transaction that does not balance, however it is written. Debits equal credits in every
// currency when the transaction commits; fewer than two lines, a zero or negative amount, a bad account or direction, and a
// changed or deleted row are all refused; posting the same fact twice returns the first transaction; and only the worker role
// can see the ledger.
import { createMigratedTestDatabase, inRole, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: TestDatabase;
const worker = <T>(work: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<T>) =>
    inRole(db.database, "aura_worker", { actorKind: "worker", userId: null, orgIds: [] }, work);
const AT = new Date(Date.UTC(2026, 9, 15));
const D = (account: string, amount: number, currency = "USD") => ({
    account,
    direction: "D",
    amount_minor: amount,
    currency,
});
const C = (account: string, amount: number, currency = "USD") => ({
    account,
    direction: "C",
    amount_minor: amount,
    currency,
});
const post = (ref: string, entries: object[]) =>
    worker(async (tx) => {
        const [row] =
            await tx`select post_ledger_txn('test_kind', ${ref}, ${AT}, ${tx.json(JSON.parse(JSON.stringify(entries)))}) as id`;
        return String(row?.["id"]);
    });

beforeAll(async () => {
    db = await createMigratedTestDatabase();
});
afterAll(async () => {
    await db.drop();
});

describe("the balancing rule", () => {
    it("accepts balanced lines, including several currencies that each balance", async () => {
        await post("ok-1", [D("cash", 1000), C("revenue", 1000)]);
        await post("ok-2", [D("cash", 500), C("revenue", 300), C("tax:vat", 200)]);
        await post("ok-3", [
            D("cash", 1000),
            C("revenue", 1000),
            D("cash", 90, "EUR"),
            C("revenue", 90, "EUR"),
        ]);
    });

    it("refuses lines that do not add up, in any currency", async () => {
        await expect(post("bad-1", [D("cash", 1000), C("revenue", 999)])).rejects.toThrow(
            /does not balance/,
        );
        await expect(
            post("bad-2", [
                D("cash", 1000),
                C("revenue", 1000),
                D("cash", 90, "EUR"),
                C("revenue", 89, "EUR"),
            ]),
        ).rejects.toThrow(/does not balance/);
        await expect(post("bad-3", [D("cash", 1000), C("revenue", 1000, "EUR")])).rejects.toThrow(
            /does not balance/,
        );
    });

    it("refuses fewer than two lines, and a missing line list", async () => {
        await expect(post("bad-4", [D("cash", 1)])).rejects.toThrow();
        await expect(post("bad-5", [])).rejects.toThrow();
    });

    it("refuses a zero or negative amount, a bad account, direction or currency", async () => {
        await expect(post("bad-6", [D("cash", 0), C("revenue", 0)])).rejects.toThrow();
        await expect(post("bad-7", [D("cash", -5), C("revenue", -5)])).rejects.toThrow();
        await expect(post("bad-8", [D("Cash Box", 5), C("revenue", 5)])).rejects.toThrow();
        await expect(
            post("bad-9", [{ ...D("cash", 5), direction: "X" }, C("revenue", 5)]),
        ).rejects.toThrow();
        await expect(
            post("bad-10", [D("cash", 5, "usd"), C("revenue", 5, "usd")]),
        ).rejects.toThrow();
    });

    it("also refuses a transaction written around the posting function", async () => {
        await expect(
            db.database.sql.begin(async (tx) => {
                const [t] =
                    await tx`insert into ledger_txns (kind, ref, occurred_at) values ('raw', 'x', ${AT}) returning id`;
                await tx`insert into ledger_entries (txn_id, line, account, direction, amount_minor, currency)
                    values (${t?.["id"]}, 1, 'cash', 'D', 10, 'USD')`;
            }),
        ).rejects.toThrow(/does not balance/);
        await expect(
            db.database.sql.begin(async (tx) => {
                await tx`insert into ledger_txns (kind, ref, occurred_at) values ('raw', 'empty', ${AT})`;
            }),
        ).rejects.toThrow(/does not balance/);
    });
});

describe("keeping the ledger", () => {
    it("returns the first transaction when the same fact is posted again, even with other numbers", async () => {
        const first = await post("once", [D("cash", 7), C("revenue", 7)]);
        const again = await post("once", [D("cash", 8), C("revenue", 8)]);
        expect(again).toBe(first);
        const [row] = await db.database
            .sql`select count(*)::int as n from ledger_txns where ref = 'once'`;
        expect(row?.["n"]).toBe(1);
    });

    it("never changes or deletes a row", async () => {
        const { sql } = db.database;
        await expect(
            sql`update ledger_entries set amount_minor = amount_minor + 1`,
        ).rejects.toThrow(/kept as it was/);
        await expect(sql`delete from ledger_entries`).rejects.toThrow(/kept as it was/);
        await expect(sql`update ledger_txns set kind = 'other'`).rejects.toThrow(/kept as it was/);
        await expect(sql`delete from ledger_txns`).rejects.toThrow(/kept as it was/);
    });

    it("is for the worker role only", async () => {
        const rows = await worker((tx) => tx`select count(*)::int as n from ledger_entries`);
        expect(Number(rows[0]?.["n"])).toBeGreaterThan(0);
        await expect(
            inRole(
                db.database,
                "aura_app",
                { actorKind: "user", userId: null, orgIds: [] },
                (tx) => tx`select * from ledger_entries`,
            ),
        ).rejects.toThrow();
        await expect(
            inRole(
                db.database,
                "aura_app",
                { actorKind: "user", userId: null, orgIds: [] },
                (tx) => tx`select post_ledger_txn('k','r',now(),'[]'::jsonb)`,
            ),
        ).rejects.toThrow();
    });
});
