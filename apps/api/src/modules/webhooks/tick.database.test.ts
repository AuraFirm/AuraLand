// Goal: deliveries are made once, signed so a receiver can verify them, retried with growing delays, and given up on after a day.
// A delivery taken by a worker that then dies is picked up again after its claim lapses; two workers never take the same delivery;
// an endpoint switched off stops receiving; and an event is queued once per endpoint however often it is raised.
import { createHmac } from "node:crypto";
import { createMigratedTestDatabase, inRole, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeliveryResult } from "../../platform/webhook-egress.ts";
import { createFakeClock } from "../../sim/world.ts";
import { DELIVERY_WINDOW_MS } from "./rules.ts";
import { deliverDueWebhooks } from "./tick.ts";

let db: TestDatabase;
let org = "";
let endpoint = "";
const SECRET = "c".repeat(64);
const START = Date.UTC(2026, 9, 15, 12);
const clock = createFakeClock(START);
const inTransaction = <T>(work: (tx: Parameters<Parameters<typeof inRole>[3]>[0]) => Promise<T>) =>
    inRole(db.database, "aura_worker", { actorKind: "worker", userId: null, orgIds: [] }, work);
interface Sent {
    url: string;
    headers: Record<string, string>;
    body: string;
}
const sent: Sent[] = [];
let answer: DeliveryResult = { outcome: "delivered", status: 200 };
const send = async (url: string, headers: Record<string, string>, body: string) => {
    sent.push({ url, headers, body });
    return answer;
};
const tick = () => deliverDueWebhooks({ clock, inTransaction, send });
const raise = (source: string) =>
    db.database
        .sql`select enqueue_webhook_event(${org}, 'env_run.finished', ${source}, '{"run_id":"evr_x"}'::jsonb, ${new Date(clock.nowUnixMs())})`;
const U = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const delivery = async (source: string) => {
    const [row] = await db.database
        .sql`select state, attempts, last_status, last_reason, next_attempt_at from webhook_deliveries where source_id = ${source}`;
    return row;
};

beforeAll(async () => {
    db = await createMigratedTestDatabase();
    const { sql } = db.database;
    await sql`insert into users (id, email, email_verified_at) values (${U(1)}, 'o@example.com', now())`;
    const [o] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'tick-co', 'Tick Co') returning id`;
    org = o?.id ?? "";
    const [e] = await sql<
        { id: string }[]
    >`insert into webhook_endpoints (org_id, url, events, secret_current, created_by, created_at)
        values (${org}, 'https://hooks.example.com/a', array['env_run.finished'], ${SECRET}, ${U(1)}, now()) returning id`;
    endpoint = e?.id ?? "";
});
afterAll(async () => {
    await db.drop();
});

describe("delivering", () => {
    it("sends a signed delivery once and records it", async () => {
        await raise(U(10));
        expect(await tick()).toBe(1);
        expect(sent).toHaveLength(1);
        const [request] = sent;
        expect(request?.url).toBe("https://hooks.example.com/a");
        const header = request?.headers["x-aura-signature"] ?? "";
        const [t, v1] = [/t=(\d+)/.exec(header)?.[1], /v1=([0-9a-f]{64})/.exec(header)?.[1]];
        expect(Number(t) * 1000).toBe(clock.nowUnixMs() - (clock.nowUnixMs() % 1000));
        expect(v1).toBe(createHmac("sha256", SECRET).update(`${t}.${request?.body}`).digest("hex"));
        expect(request?.headers["x-aura-event"]).toBe("env_run.finished");
        expect(request?.headers["x-aura-delivery"]).toMatch(/^whd_/);
        expect(JSON.parse(request?.body ?? "{}")).toMatchObject({
            type: "env_run.finished",
            data: { run_id: "evr_x" },
        });
        expect(await delivery(U(10))).toMatchObject({
            state: "delivered",
            attempts: 1,
            last_status: 200,
        });
        expect(await tick()).toBe(0); // nothing is sent twice
    });

    it("queues an event once per endpoint however often it is raised", async () => {
        await raise(U(11));
        await raise(U(11));
        const [row] = await db.database
            .sql`select count(*)::int as n from webhook_deliveries where source_id = ${U(11)}`;
        expect(row?.["n"]).toBe(1);
        await tick();
    });

    it("signs with the previous secret too while a rotation overlaps", async () => {
        const next = "d".repeat(64);
        await db.database
            .sql`update webhook_endpoints set secret_previous = secret_current, secret_current = ${next},
            secret_rotated_at = ${new Date(clock.nowUnixMs())} where id = ${endpoint}`;
        sent.length = 0;
        await raise(U(12));
        await tick();
        expect(sent[0]?.headers["x-aura-signature"]?.match(/v1=/g)).toHaveLength(2);
    });
});

describe("failing and retrying", () => {
    it("retries after a rejection with doubling delays and records only a fixed reason", async () => {
        answer = { outcome: "rejected", status: 500 };
        await raise(U(20));
        await tick();
        const first = await delivery(U(20));
        expect(first).toMatchObject({
            state: "pending",
            attempts: 1,
            last_status: 500,
            last_reason: "receiver answered 500",
        });
        expect(new Date(String(first?.["next_attempt_at"])).getTime()).toBe(
            clock.nowUnixMs() + 30_000,
        );
        expect(await tick()).toBe(0); // not yet due
        clock.advance(30_000);
        await tick();
        const second = await delivery(U(20));
        expect(second).toMatchObject({ attempts: 2 });
        expect(new Date(String(second?.["next_attempt_at"])).getTime()).toBe(
            clock.nowUnixMs() + 60_000,
        );
    });

    it("gives up after the 24-hour window", async () => {
        clock.advance(DELIVERY_WINDOW_MS);
        await tick();
        expect(await delivery(U(20))).toMatchObject({ state: "dead", next_attempt_at: null });
        answer = { outcome: "delivered", status: 200 };
    });

    it("gives up at once on an endpoint that was switched off", async () => {
        await raise(U(21));
        await db.database.sql`update webhook_endpoints set active = false where id = ${endpoint}`;
        sent.length = 0;
        expect(await tick()).toBe(0);
        expect(sent).toHaveLength(0);
        expect(await delivery(U(21))).toMatchObject({
            state: "dead",
            last_reason: "endpoint switched off",
        });
        await db.database.sql`update webhook_endpoints set active = true where id = ${endpoint}`;
    });
});

describe("workers", () => {
    it("never let two workers take the same delivery, and recover one a dead worker held", async () => {
        sent.length = 0;
        await raise(U(30));
        const slow = async (url: string, headers: Record<string, string>, body: string) => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return send(url, headers, body);
        };
        const run = () => deliverDueWebhooks({ clock, inTransaction, send: slow });
        const counts = await Promise.all([run(), run()]);
        expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
        expect(sent).toHaveLength(1);

        // A worker takes a delivery and dies: the claim lapses after a minute and the next worker sends it.
        await raise(U(31));
        await inTransaction(
            (tx) =>
                tx`select * from claim_due_webhook_deliveries(${new Date(clock.nowUnixMs())}, 10)`,
        );
        expect(await tick()).toBe(0);
        clock.advance(61_000);
        expect(await tick()).toBe(1);
        expect(await delivery(U(31))).toMatchObject({ state: "delivered" });
    });
});
