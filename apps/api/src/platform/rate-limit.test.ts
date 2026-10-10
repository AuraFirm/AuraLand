// Goal: fixed-window rate limiting must allow exactly `max` hits per window, tell the caller how
// long to wait, keep different rules and identifiers apart, and count atomically in PostgreSQL even
// when many requests arrive together.
import { withRequestContext } from "@aura/db/context";
import { createMigratedTestDatabase, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeClock } from "../sim/world.ts";
import {
    checkRateLimit,
    createMemoryCounterStore,
    createPgCounterStore,
    type RateLimitRule,
    rateLimitKeyHash,
    windowStartMs,
} from "./rate-limit.ts";

const KEY = Buffer.alloc(32, 4);
const START = 1_800_000_040_000; // 40 seconds into a minute, a multiple of 1000
const RULE: RateLimitRule = { name: "test:minute", max: 3, windowS: 60 };

describe("windowStartMs", () => {
    it("rounds down to the start of the window, exactly at the boundaries", () => {
        expect(windowStartMs(120_000, 60)).toBe(120_000);
        expect(windowStartMs(179_999, 60)).toBe(120_000);
        expect(windowStartMs(180_000, 60)).toBe(180_000);
        expect(windowStartMs(0, 60)).toBe(0);
    });

    it("rejects negative times and non-positive windows", () => {
        expect(() => windowStartMs(-1, 60)).toThrow(/time/);
        expect(() => windowStartMs(10, 0)).toThrow(/window/);
        expect(() => windowStartMs(10, 1.5)).toThrow(/window/);
    });
});

describe("rateLimitKeyHash", () => {
    it("differs by rule and identifier, depends on the key, and hides its inputs", () => {
        const base = rateLimitKeyHash(KEY, RULE, "203.0.113.7");
        expect(base).toMatch(/^[0-9a-f]{64}$/);
        expect(rateLimitKeyHash(KEY, RULE, "203.0.113.8")).not.toBe(base);
        expect(rateLimitKeyHash(KEY, { ...RULE, name: "other" }, "203.0.113.7")).not.toBe(base);
        expect(rateLimitKeyHash(Buffer.alloc(32, 5), RULE, "203.0.113.7")).not.toBe(base);
        expect(base).not.toContain("203");
    });

    it("cannot confuse a rule and an identifier that concatenate to the same text", () => {
        const a = rateLimitKeyHash(KEY, { ...RULE, name: "a" }, "b|c");
        const b = rateLimitKeyHash(KEY, { ...RULE, name: "a|b" }, "c");
        expect(a).not.toBe(b);
    });
});

describe("checkRateLimit with the in-memory store", () => {
    const setup = () => ({ clock: createFakeClock(START), store: createMemoryCounterStore() });

    it("allows exactly max hits, then refuses until the window ends", async () => {
        const { clock, store } = setup();
        const hit = () => checkRateLimit({ store, clock, key: KEY }, RULE, "ip");
        for (let n = 1; n <= RULE.max; n++) expect((await hit()).allowed, `hit ${n}`).toBe(true);
        const refused = await hit();
        expect(refused.allowed).toBe(false);
        expect(refused.count).toBe(RULE.max + 1);
        expect(refused.retryAfterS).toBe(20); // 40 s into the minute leaves 20 s.
    });

    it("starts fresh in the next window, exactly at the boundary", async () => {
        const { clock, store } = setup();
        const hit = () => checkRateLimit({ store, clock, key: KEY }, RULE, "ip");
        for (let n = 0; n < RULE.max + 1; n++) await hit();
        clock.advance(19_999);
        expect((await hit()).allowed).toBe(false);
        clock.advance(1);
        expect(await hit()).toMatchObject({ allowed: true, count: 1 });
    });

    it("keeps identifiers and rules apart", async () => {
        const { clock, store } = setup();
        for (let n = 0; n < RULE.max + 1; n++)
            await checkRateLimit({ store, clock, key: KEY }, RULE, "ip-a");
        expect((await checkRateLimit({ store, clock, key: KEY }, RULE, "ip-b")).allowed).toBe(true);
        expect(
            (await checkRateLimit({ store, clock, key: KEY }, { ...RULE, name: "other" }, "ip-a"))
                .allowed,
        ).toBe(true);
    });

    it("reports a whole second of wait, never zero, even in the last millisecond", async () => {
        const { clock, store } = setup();
        clock.advance(19_999);
        for (let n = 0; n < RULE.max + 1; n++)
            await checkRateLimit({ store, clock, key: KEY }, RULE, "ip");
        const last = await checkRateLimit({ store, clock, key: KEY }, RULE, "ip");
        expect(last.retryAfterS).toBe(1);
    });
});

describe("checkRateLimit with PostgreSQL", () => {
    let db: TestDatabase;
    beforeAll(async () => {
        db = await createMigratedTestDatabase(10);
    });
    afterAll(async () => {
        await db.drop();
    });

    const run = <T>(work: (store: ReturnType<typeof createPgCounterStore>) => Promise<T>) =>
        withRequestContext(
            db.database.sql,
            { role: "aura_auth", actorKind: "anonymous", userId: null, orgIds: [] },
            (tx) => work(createPgCounterStore(tx)),
        );

    it("counts atomically: many simultaneous hits get distinct counts and exactly max are allowed", async () => {
        const clock = createFakeClock(START);
        const results = await Promise.all(
            Array.from({ length: 12 }, () =>
                run((store) => checkRateLimit({ store, clock, key: KEY }, RULE, "burst")),
            ),
        );
        expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(
            Array.from({ length: 12 }, (_, i) => i + 1),
        );
        expect(results.filter((r) => r.allowed).length).toBe(RULE.max);
    });

    it("agrees with the in-memory store step by step across windows", async () => {
        const clockM = createFakeClock(START);
        const clockP = createFakeClock(START);
        const memory = createMemoryCounterStore();
        for (let step = 0; step < 14; step++) {
            const fromMemory = await checkRateLimit(
                { store: memory, clock: clockM, key: KEY },
                RULE,
                "walk",
            );
            const fromPg = await run((store) =>
                checkRateLimit({ store, clock: clockP, key: KEY }, RULE, "walk"),
            );
            expect(fromPg, `step ${step}`).toEqual(fromMemory);
            if (step % 4 === 3) {
                clockM.advance(30_000);
                clockP.advance(30_000);
            }
        }
    });
});
