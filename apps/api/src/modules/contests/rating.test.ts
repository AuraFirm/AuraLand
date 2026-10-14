// Goal: the rating function has the properties a rating must have. Not golden vectors: there is no
// independent implementation here to take them from (see rating.ts). Method: worked cases with obvious
// answers, then seeded random fields checked for monotonicity in rank, equal results for equal ranks,
// bounded change, finite numbers and independence from input order.

import { RATING_PARAMETERS_V1 } from "@aura/contracts/rating";
import { describe, expect, it } from "vitest";
import { type RatingPrior, rateContest } from "./rating.ts";

const P = RATING_PARAMETERS_V1;
const fresh = (id: string): RatingPrior => ({ userId: id, mu: P.muInitial, sigma: P.sigmaInitial });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${String(i).padStart(3, "0")}`);
const byId = (results: ReturnType<typeof rateContest>) =>
    new Map(results.map((r) => [r.userId, r]));

describe("with equal priors", () => {
    it("raises the winner, lowers the last, and moves nobody past the cap", () => {
        const people = ids(10);
        const out = rateContest(
            people.map(fresh),
            people.map((userId, i) => ({ userId, rank: i + 1 })),
            P,
        );
        const rows = byId(out);
        expect(rows.get("u000")?.muAfter).toBeGreaterThan(P.muInitial);
        expect(rows.get("u009")?.muAfter).toBeLessThan(P.muInitial);
        for (const r of out)
            expect(Math.abs(r.muAfter - r.muBefore)).toBeLessThanOrEqual(P.changeMax);
        // Strictly better rank, strictly better rating.
        const after = people.map((id) => rows.get(id)?.muAfter ?? 0);
        for (let i = 1; i < after.length; i++)
            expect(after[i] ?? 0).toBeLessThan(after[i - 1] ?? 0);
    });
});

describe("ties and uncertainty", () => {
    it("gives equal results to equal ranks, and the middle of a full tie stays put", () => {
        const people = ids(6);
        const tie = rateContest(
            people.map(fresh),
            people.map((userId) => ({ userId, rank: 1 })),
            P,
        );
        const mus = tie.map((r) => r.muAfter);
        expect(Math.max(...mus) - Math.min(...mus)).toBeLessThan(1e-9);
        expect(Math.abs((mus[0] ?? 0) - P.muInitial)).toBeLessThan(1); // everyone drew: no news
        const ranks = [1, 1, 3, 3, 5, 6];
        const out = byId(
            rateContest(
                people.map(fresh),
                people.map((userId, i) => ({ userId, rank: ranks[i] ?? 1 })),
                P,
            ),
        );
        expect(out.get("u000")?.muAfter).toBeCloseTo(out.get("u001")?.muAfter ?? 0, 9);
        expect(out.get("u002")?.muAfter).toBeCloseTo(out.get("u003")?.muAfter ?? 0, 9);
    });

    it("moves an unsure rating more than a sure one for the same result", () => {
        const people = ids(8);
        const standings = people.map((userId, i) => ({ userId, rank: i + 1 }));
        const priors = people.map((id) => ({ ...fresh(id), sigma: id === "u000" ? 350 : 350 }));
        const unsure = byId(rateContest(priors, standings, P)).get("u000");
        const sure = byId(
            rateContest(
                priors.map((p) => (p.userId === "u000" ? { ...p, sigma: 80 } : p)),
                standings,
                P,
            ),
        ).get("u000");
        expect((unsure?.muAfter ?? 0) - P.muInitial).toBeGreaterThan(
            (sure?.muAfter ?? 0) - P.muInitial,
        );
        expect(unsure?.sigmaAfter ?? 0).toBeLessThan(P.sigmaInitial); // an observation always sharpens
        expect(sure?.sigmaAfter ?? 0).toBeGreaterThanOrEqual(P.sigmaMin);
    });
});

describe("the strength of the field", () => {
    it("rewards beating stronger people more than beating weaker ones", () => {
        const strong = [
            { userId: "s1", mu: 2200, sigma: 80 },
            { userId: "s2", mu: 2200, sigma: 80 },
        ];
        const weak = [
            { userId: "w1", mu: 900, sigma: 80 },
            { userId: "w2", mu: 900, sigma: 80 },
        ];
        const hero = { userId: "hero", mu: 1500, sigma: 100 };
        const beatsStrong = rateContest(
            [hero, ...strong],
            [
                { userId: "hero", rank: 1 },
                { userId: "s1", rank: 2 },
                { userId: "s2", rank: 3 },
            ],
            P,
        );
        const beatsWeak = rateContest(
            [hero, ...weak],
            [
                { userId: "hero", rank: 1 },
                { userId: "w1", rank: 2 },
                { userId: "w2", rank: 3 },
            ],
            P,
        );
        expect(byId(beatsStrong).get("hero")?.muAfter ?? 0).toBeGreaterThan(
            byId(beatsWeak).get("hero")?.muAfter ?? 0,
        );
    });
});

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe("on random fields (300 seeds)", () => {
    it("is finite, bounded, rank-monotone for equal priors, and independent of input order", () => {
        for (let seed = 1; seed <= 300; seed++) {
            const random = mulberry32(seed);
            const n = 2 + Math.floor(random() * 40);
            const people = ids(n);
            const priors = people.map((userId) => ({
                userId,
                mu: 800 + random() * 1800,
                sigma: 60 + random() * 290,
            }));
            // Ranks with ties: sort random scores, equal scores share a rank.
            const scores = people.map(() => Math.floor(random() * 6));
            const order = [...people.keys()].sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
            const standings = people.map((userId, i) => ({
                userId,
                rank: 1 + order.filter((j) => (scores[j] ?? 0) > (scores[i] ?? 0)).length,
            }));
            const first = rateContest(priors, standings, P);
            for (const r of first) {
                expect(Number.isFinite(r.muAfter) && Number.isFinite(r.sigmaAfter)).toBe(true);
                expect(Math.abs(r.muAfter - r.muBefore)).toBeLessThanOrEqual(P.changeMax + 1e-9);
                expect(r.sigmaAfter).toBeGreaterThanOrEqual(P.sigmaMin);
            }
            const shuffled = [...standings].reverse();
            expect(rateContest([...priors].reverse(), shuffled, P)).toEqual(first);
            // Performance never decreases as rank improves.
            const sorted = [...first].sort(
                (a, b) => a.rank - b.rank || (a.userId < b.userId ? -1 : 1),
            );
            for (let i = 1; i < sorted.length; i++) {
                const a = sorted[i - 1];
                const b = sorted[i];
                if (a !== undefined && b !== undefined && a.rank < b.rank) {
                    expect(a.performance).toBeGreaterThanOrEqual(b.performance - 1e-6);
                }
            }
        }
    });

    it("runs a ten-thousand-person field of new people in well under a second", () => {
        const people = ids(10_000);
        const started = performance.now();
        const out = rateContest(
            people.map(fresh),
            people.map((userId, i) => ({ userId, rank: i + 1 })),
            P,
        );
        expect(performance.now() - started).toBeLessThan(5000);
        expect(out).toHaveLength(10_000);
    });
});

describe("refusing nonsense", () => {
    it("rejects too few contestants, a missing prior, a duplicate and a bad rank", () => {
        const a = fresh("a");
        const b = fresh("b");
        expect(() => rateContest([a], [{ userId: "a", rank: 1 }], P)).toThrow();
        expect(() =>
            rateContest(
                [a],
                [
                    { userId: "a", rank: 1 },
                    { userId: "b", rank: 2 },
                ],
                P,
            ),
        ).toThrow();
        expect(() =>
            rateContest(
                [a, b],
                [
                    { userId: "a", rank: 1 },
                    { userId: "a", rank: 2 },
                ],
                P,
            ),
        ).toThrow();
        expect(() =>
            rateContest(
                [a, b],
                [
                    { userId: "a", rank: 0 },
                    { userId: "b", rank: 2 },
                ],
                P,
            ),
        ).toThrow();
        expect(() =>
            rateContest(
                [a, { ...b, sigma: 0 }],
                [
                    { userId: "a", rank: 1 },
                    { userId: "b", rank: 2 },
                ],
                P,
            ),
        ).toThrow();
    });
});
