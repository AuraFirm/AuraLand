import {
    publicProfileSchema,
    ratingHistoryQuerySchema,
    ratingHistorySchema,
} from "@aura/contracts/api/ratings";
import { decodeId, encodeId } from "@aura/contracts/ids";
import {
    RATING_DIMENSION_CONTEST,
    RATING_PROVISIONAL_CONTESTS,
    ratingTierOf,
} from "@aura/contracts/rating";
import type { Transaction } from "@aura/db/context";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.ts";
import { problemResponse } from "../../platform/problem-response.ts";

// Public profiles and rating history. What is readable is decided by the policies of migration 0040 and the
// profiles table (a profile is readable when public, or by its owner); a person who is not readable is a 404
// here, the same as a person who does not exist.

const HANDLE = /^[A-Za-z0-9_]{3,24}$/;

export function ratingRoutes(): Hono<AppEnv> {
    const routes = new Hono<AppEnv>();
    routes.get("/users/:handle", handleProfile);
    routes.get("/users/:handle/ratings", handleHistory);
    return routes;
}

const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");

const personSchema = z.object({
    user_id: z.string(),
    handle: z.string(),
    display_name: z.string(),
});
const standingSchema = z.object({ mu: z.number(), sigma: z.number(), contests: z.number() });

async function personOf(tx: Transaction, handle: string) {
    const rows = await tx`select user_id, handle::text as handle, display_name from profiles
        where handle = ${handle}`;
    return rows[0] === undefined ? null : personSchema.parse(rows[0]);
}

async function summaryOf(tx: Transaction, userId: string) {
    const rows = await tx`select mu, sigma, contests from ratings
        where user_id = ${userId} and dimension = ${RATING_DIMENSION_CONTEST}`;
    if (rows[0] === undefined) return null;
    const row = standingSchema.parse(rows[0]);
    const rating = Math.round(row.mu);
    const tier = ratingTierOf(rating);
    return {
        rating,
        uncertainty: Math.round(row.sigma),
        contests: row.contests,
        tier: tier.name,
        color: tier.color,
        provisional: row.contests < RATING_PROVISIONAL_CONTESTS,
    };
}

async function handleProfile(c: Context<AppEnv>) {
    const handle = c.req.param("handle") ?? "";
    if (!HANDLE.test(handle)) return notFound(c);
    const tx = c.get("tx");
    const person = await personOf(tx, handle);
    if (person === null) return notFound(c);
    return c.json(
        publicProfileSchema.parse({
            handle: person.handle,
            display_name: person.display_name,
            rating: await summaryOf(tx, person.user_id),
        }),
    );
}

const eventSchema = z.object({
    contest_id: z.string(),
    title: z.string(),
    rank: z.number(),
    mu_before: z.number(),
    mu_after: z.number(),
    performance: z.number(),
    ends_at: z.date(),
});

async function handleHistory(c: Context<AppEnv>) {
    const handle = c.req.param("handle") ?? "";
    const query = ratingHistoryQuerySchema.safeParse(c.req.query());
    if (!query.success) return problemResponse(c, "invalid_request", "Invalid request");
    if (!HANDLE.test(handle)) return notFound(c);
    const tx = c.get("tx");
    const person = await personOf(tx, handle);
    if (person === null) return notFound(c);
    const cursor = query.data.cursor === undefined ? null : decodeId("cst", query.data.cursor);
    // Newest contest first; (end, id) is unique, so the order is total and the cursor exact.
    const rows =
        await tx`select e.contest_id, c.title, e.rank, e.mu_before, e.mu_after, e.performance, c.ends_at
        from rating_events e join contests c on c.id = e.contest_id
        where e.user_id = ${person.user_id} and e.dimension = ${RATING_DIMENSION_CONTEST}
          and ${cursor === null ? tx`true` : tx`(c.ends_at, c.id) < (select ends_at, id from contests where id = ${cursor})`}
        order by c.ends_at desc, c.id desc limit ${query.data.limit + 1}`;
    const events = rows.map((row) => eventSchema.parse(row));
    const page = events.slice(0, query.data.limit);
    const last = page[page.length - 1];
    return c.json(
        ratingHistorySchema.parse({
            handle: person.handle,
            rating: await summaryOf(tx, person.user_id),
            items: page.map((e) => ({
                contest_id: encodeId("cst", e.contest_id),
                contest_title: e.title,
                rank: e.rank,
                rating_before: Math.round(e.mu_before),
                rating_after: Math.round(e.mu_after),
                change: Math.round(e.mu_after) - Math.round(e.mu_before),
                performance: Math.round(e.performance),
                at: e.ends_at.toISOString(),
            })),
            next_cursor:
                events.length > query.data.limit && last !== undefined
                    ? encodeId("cst", last.contest_id)
                    : null,
        }),
    );
}
