// Goal: the TypeScript clock rules and the database function advance_contests never disagree. They are
// written twice on purpose (one is what the worker runs, the other what the tests and screens reason with),
// so this test runs both on thousands of random contests and instants and compares the answers.
import { createMigratedTestDatabase, type TestDatabase } from "@aura/db/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ContestClock, stateAt } from "./rules.ts";

const OWNER = "018f0000-0000-7000-8000-0000000005f1";
const MINUTE = 60_000;
let db: TestDatabase;
let host = "";
beforeAll(async () => {
    db = await createMigratedTestDatabase(4);
    const { sql } = db.database;
    await sql`insert into users (id, email) values (${OWNER}, 'sim@example.com')`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'sim-uni', 'S') returning id`;
    host = org?.id ?? "";
});
afterAll(async () => {
    await db.drop();
});

// A seeded random source so a failure names the seed that reproduces it.
function rng(seed: number): (n: number) => number {
    let state = seed >>> 0;
    return (n) => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % n;
    };
}

describe("advance_contests against stateAt", () => {
    it("agrees on 300 random contests at 4 random instants each", async () => {
        const { sql } = db.database;
        const next = rng(20261014);
        for (let round = 0; round < 300; round++) {
            const startsAt = Date.UTC(2026, 10, 1) + next(100_000) * MINUTE;
            const duration = (5 + next(7 * 24 * 60 - 5)) * MINUTE;
            const freezeOffset =
                next(3) === 0 ? null : (1 + next(Math.floor(duration / MINUTE) - 1)) * MINUTE;
            const clock: ContestClock = {
                state: "scheduled",
                startsAtMs: startsAt,
                endsAtMs: startsAt + duration,
                freezeAtMs: freezeOffset === null ? null : startsAt + freezeOffset,
            };
            const [row] = await sql<
                { id: string }[]
            >`insert into contests (org_id, slug, title, format, rules, starts_at, ends_at, freeze_at, created_by)
                values (${host}, ${`sim-${round}`}, 't', 'ioi', ${sql.json({ format: "ioi" })}, ${new Date(clock.startsAtMs)},
                        ${new Date(clock.endsAtMs)}, ${clock.freezeAtMs === null ? null : new Date(clock.freezeAtMs)}, ${OWNER}) returning id`;
            const id = row?.id ?? "";
            await sql`update contests set state = 'scheduled' where id = ${id}`;
            // Instants spread around the boundaries as well as far from them.
            const instants = [
                clock.startsAtMs - 1,
                clock.startsAtMs + next(duration),
                (clock.freezeAtMs ?? clock.startsAtMs) + next(3) - 1,
                clock.endsAtMs + next(3) - 1,
            ].sort((a, b) => a - b);
            let tracked = clock.state;
            for (const instant of instants) {
                await sql`select * from advance_contests(${new Date(instant)})`;
                tracked = stateAt({ ...clock, state: tracked }, instant);
                const [now] = await sql<
                    { state: string }[]
                >`select state from contests where id = ${id}`;
                expect(now?.state, `round ${round}, instant ${instant}, seed 20261014`).toBe(
                    tracked,
                );
            }
        }
    }, 120_000);
});
