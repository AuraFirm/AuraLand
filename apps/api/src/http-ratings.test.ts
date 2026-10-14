// Goal: public profiles and rating history through the real HTTP app. Only a public profile is readable (an
// unlisted, private or missing one is the same 404, except to its owner); ratings round and name their tier;
// history is newest first and pages exactly; nothing names a user id; and a rated contest must be public.

import { randomBytes } from "node:crypto";
import { contestSchema } from "@aura/contracts/api/contests";
import { publicProfileSchema, ratingHistorySchema } from "@aura/contracts/api/ratings";
import { encodeId } from "@aura/contracts/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
const DAVE = "018f0000-0000-7000-8000-0000000000d4";
const HOUR = 3_600_000;
let h: Harness;
let host = "";
const contests: string[] = [];

beforeAll(async () => {
    h = await createHarness();
    const { sql } = h.db.database;
    for (const [id, name] of [
        [CAROL, "carol"],
        [DAVE, "dave"],
    ] as const) {
        await sql`insert into users (id, email, email_verified_at) values (${id}, ${`${name}@example.com`}, now())`;
        await sql`insert into profiles (user_id, handle, display_name, visibility) values (${id}, ${`${name}_x`}, ${name}, ${name === "carol" ? "unlisted" : "private"})`;
    }
    await sql`update profiles set visibility = 'public' where user_id = ${ALICE}`;
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('university', 'rating-uni', 'U') returning id`;
    host = org?.id ?? "";
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 3; i++) {
        const [c] = await sql<
            { id: string }[]
        >`insert into contests (org_id, slug, title, format, rules, starts_at, ends_at, created_by, rated)
            values (${host}, ${`r-${i}`}, ${`Round ${i + 1}`}, 'icpc', ${sql.json({ format: "icpc" })}, ${new Date(base + i * 24 * HOUR)}, ${new Date(base + i * 24 * HOUR + 5 * HOUR)}, ${ALICE}, true) returning id`;
        for (const state of ["scheduled", "running", "ended"])
            await sql`update contests set state = ${state} where id = ${c?.id ?? ""}`;
        contests.push(c?.id ?? "");
    }
    // Alice: 1500 -> 1561.4 -> 1610.2 -> 1687.9 over three contests (rounded in responses).
    const steps: [number, number][] = [
        [1500, 1561.4],
        [1561.4, 1610.2],
        [1610.2, 1687.9],
    ];
    for (const [i, [before, after]] of steps.entries()) {
        await sql`insert into rating_events (user_id, contest_id, dimension, rank, mu_before, mu_after, sigma_after, performance, created_at)
            values (${ALICE}, ${contests[i] ?? ""}, 'contest', ${i + 1}, ${before}, ${after}, 150, ${after + 40.2}, now())`;
    }
    await sql`insert into ratings (user_id, dimension, mu, sigma, contests, updated_at) values (${ALICE}, 'contest', 1687.9, 150.4, 3, now())`;
    await sql`insert into ratings (user_id, dimension, mu, sigma, contests, updated_at) values (${CAROL}, 'contest', 2450, 70, 9, now())`;
    await sql`insert into ratings (user_id, dimension, mu, sigma, contests, updated_at) values (${DAVE}, 'contest', 900, 70, 9, now())`;
    void randomBytes;
});
afterAll(async () => {
    await h.drop();
});

const get = async (user: string | null, path: string) =>
    h.request(path, { headers: browser(user === null ? null : (await h.login(user)).token) });

describe("a public profile", () => {
    it("shows the rating rounded, its tier and that it is still settling", async () => {
        const response = await get(null, "/users/alice");
        expect(response.status).toBe(200);
        const profile = publicProfileSchema.parse(await response.json());
        expect(profile).toMatchObject({
            handle: "alice",
            display_name: "Alice",
            rating: {
                rating: 1688,
                uncertainty: 150,
                contests: 3,
                tier: "Expert",
                color: "blue",
                provisional: true,
            },
        });
        expect(JSON.stringify(profile)).not.toContain(ALICE);
        expect((await get(null, "/users/ALICE")).status).toBe(200); // handles ignore case
    });

    it("is the same 404 for an unlisted, a private and a missing person, but not for its owner", async () => {
        const unlisted = await get(null, "/users/carol_x");
        const hidden = await get(null, "/users/dave_x");
        const missing = await get(null, "/users/nobody_at_all");
        expect([unlisted.status, hidden.status, missing.status]).toEqual([404, 404, 404]);
        const shape = async (response: Response) => {
            const { title, status, detail } = z
                .object({ title: z.string(), status: z.number(), detail: z.string().optional() })
                .parse(await response.json());
            return { title, status, detail };
        };
        expect(await shape(unlisted)).toEqual(await shape(missing)); // nothing tells them apart
        expect((await get(BOB, "/users/carol_x")).status).toBe(404);
        expect((await get(CAROL, "/users/carol_x")).status).toBe(200); // their own page
        expect((await get(null, "/users/a!")).status).toBe(404);
    });
});

describe("rating history", () => {
    it("lists the newest contest first with whole-number changes, and pages exactly", async () => {
        const first = ratingHistorySchema.parse(
            await (await get(null, "/users/alice/ratings?limit=2")).json(),
        );
        expect(first.items.map((i) => i.contest_title)).toEqual(["Round 3", "Round 2"]);
        expect(first.items[0]).toMatchObject({
            rank: 3,
            rating_before: 1610,
            rating_after: 1688,
            change: 78,
            performance: 1728,
        });
        expect(first.next_cursor).not.toBeNull();
        const second = ratingHistorySchema.parse(
            await (
                await get(null, `/users/alice/ratings?limit=2&cursor=${first.next_cursor}`)
            ).json(),
        );
        expect(second.items.map((i) => i.contest_title)).toEqual(["Round 1"]);
        expect(second.next_cursor).toBeNull();
        expect(JSON.stringify([first, second])).not.toContain(ALICE);
    });

    it("refuses what is not a profile, a page size or a cursor", async () => {
        expect((await get(null, "/users/carol_x/ratings")).status).toBe(404);
        expect((await get(null, "/users/alice/ratings?limit=0")).status).toBe(400);
        expect((await get(null, "/users/alice/ratings?cursor=junk")).status).toBe(400);
        expect((await get(null, "/users/alice/ratings?extra=1")).status).toBe(400);
    });
});

describe("the tier colors", () => {
    it("name a tier for every public rating (colors are never the only signal)", async () => {
        await h.db.database
            .sql`update profiles set visibility = 'public' where user_id in (${CAROL}, ${DAVE})`;
        const high = publicProfileSchema.parse(await (await get(null, "/users/carol_x")).json());
        const low = publicProfileSchema.parse(await (await get(null, "/users/dave_x")).json());
        expect([high.rating?.tier, high.rating?.color, high.rating?.provisional]).toEqual([
            "Legend",
            "red",
            false,
        ]);
        expect([low.rating?.tier, low.rating?.color]).toEqual(["Newcomer", "gray"]);
    });
});

describe("rated contests", () => {
    it("must be public, in the request and in the database", async () => {
        const body = {
            slug: "private-rated",
            title: "Nope",
            rules: { format: "icpc" },
            starts_at: new Date(Date.now() + 2 * HOUR).toISOString(),
            ends_at: new Date(Date.now() + 7 * HOUR).toISOString(),
            rated: true,
            visibility: "private",
        };
        const login = await h.login(ALICE);
        await h.db.database
            .sql`insert into memberships (org_id, user_id, role) values (${host}, ${ALICE}, 'owner') on conflict do nothing`;
        const refused = await h.request(`/orgs/${encodeId("org", host)}/contests`, {
            method: "POST",
            headers: browser(login.token, { "content-type": "application/json" }),
            body: JSON.stringify(body),
        });
        expect(refused.status).toBe(400);
        const ok = await h.request(`/orgs/${encodeId("org", host)}/contests`, {
            method: "POST",
            headers: browser(login.token, { "content-type": "application/json" }),
            body: JSON.stringify({ ...body, slug: "public-rated", visibility: "public" }),
        });
        expect(ok.status).toBe(201);
        expect(contestSchema.parse(await ok.json()).rated).toBe(true);
        await expect(
            h.db.database
                .sql`update contests set visibility = 'private' where slug = 'public-rated'`,
        ).rejects.toThrow(/contests_rated_public/);
    });
});
