// Goal: the previous month is reconciled once. Our counts (from the usage events of that month only) go to the provider; what it
// holds is compared; a clean month and a month with differences are both recorded, exactly once; this month is never touched.
import { createMigratedTestDatabase, inRole, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeClock } from "../../sim/world.ts";
import { createFakePaymentProvider } from "./provider.ts";
import { reconcilePreviousMonth } from "./tick.ts";

let db: TestDatabase;
let orgA = "";
let orgB = "";
const NOW = Date.UTC(2026, 9, 15, 12); // October; the month to close is September
const clock = createFakeClock(NOW);
const inTransaction = <T>(work: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<T>) =>
    inRole(db.database, "aura_worker", { actorKind: "worker", userId: null, orgIds: [] }, work);
const tick = (provider = createFakePaymentProvider()) =>
    reconcilePreviousMonth({ clock, provider, inTransaction }).then((result) => ({
        result,
        provider,
    }));
const event = async (org: string, kind: string, source: string, at: Date) => {
    await db.database
        .sql`insert into usage_events (org_id, kind, source_id, occurred_at) values (${org}, ${kind}, ${source}, ${at})`;
};

beforeAll(async () => {
    db = await createMigratedTestDatabase();
    const rows = await db.database.sql<{ id: string }[]>`insert into orgs (kind, slug, name)
        values ('company', 'rec-a', 'A'), ('company', 'rec-b', 'B') returning id`;
    [orgA, orgB] = [rows[0]?.id ?? "", rows[1]?.id ?? ""];
    const U = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
    const september = (day: number) => new Date(Date.UTC(2026, 8, day, 10));
    await event(orgA, "env_run", U(1), september(2));
    await event(orgA, "env_run", U(2), september(30));
    await event(orgB, "employer_report", U(3), september(15));
    await event(orgA, "env_run", U(4), new Date(Date.UTC(2026, 7, 31, 23, 59))); // August: not counted
    await event(orgA, "env_run", U(5), new Date(Date.UTC(2026, 9, 1))); // October: not counted
});
afterAll(async () => {
    await db.drop();
});

describe("reconcilePreviousMonth", () => {
    it("tells a disagreeing provider's books from ours and records the month once", async () => {
        const provider = createFakePaymentProvider();
        const real = provider.reportUsage;
        // This provider keeps one count too few for the first organization, and invents a line.
        provider.reportUsage = async (period, lines) => {
            await real(
                period,
                lines.map((l) => (l.count === 2 ? { ...l, count: 1 } : l)),
            );
            provider.held.set(period, [
                ...(provider.held.get(period) ?? []),
                { org: "org_018f0000-0000-7000-8000-00000000beef", kind: "env_run", count: 4 },
            ]);
        };
        const { result } = await tick(provider);
        expect(result).toEqual({ period: "2026-09", differences: 2 });
        const [row] = await db.database
            .sql`select status, differences, ours from reconciliations where period = '2026-09'`;
        expect(row?.["status"]).toBe("differences");
        expect(JSON.stringify(row?.["differences"])).toContain("count_mismatch");
        expect(JSON.stringify(row?.["differences"])).toContain("unknown_at_provider");
        // Only September's three events were counted.
        expect(JSON.stringify(row?.["ours"])).toContain('"count":2');
        expect(JSON.stringify(row?.["ours"])).not.toContain('"count":3');
    });

    it("does nothing the second time, and never touches the month already recorded", async () => {
        const { result, provider } = await tick();
        expect(result).toBeNull();
        expect(provider.held.size).toBe(0); // the provider was not even told
        const [row] = await db.database.sql`select count(*)::int as n from reconciliations`;
        expect(row?.["n"]).toBe(1);
        await expect(
            db.database.sql`update reconciliations set status = 'clean'`,
        ).rejects.toThrow();
    });

    it("records a clean month as clean", async () => {
        clock.advance(31 * 24 * 3600 * 1000); // into November: October is the month to close
        const { result } = await tick();
        // October had one event (orgA's, on the 1st), and the fake provider keeps what it was told.
        expect(result).toEqual({ period: "2026-10", differences: 0 });
        const [row] = await db.database
            .sql`select status from reconciliations where period = '2026-10'`;
        expect(row?.["status"]).toBe("clean");
        expect(orgB).not.toBe("");
    });
});
