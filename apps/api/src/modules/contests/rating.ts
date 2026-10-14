import { assert } from "@aura/contracts/assert";
import { RATING_PARTICIPANTS_MAX, type RatingParameters } from "@aura/contracts/rating";

// The rating of a finished contest, as a pure function (Stage 5, ADR 0031 decision 7). Elo-MMR style:
// each contestant's rank in the contest is turned into a performance (the rating at which they would be
// expected to take exactly that rank against this field), and their rating moves toward that performance
// by the Gaussian posterior, so unsure ratings move more than sure ones.
//
// What this is not: a port of the published Elo-MMR code. It follows the idea (rank-only input, logistic
// win probabilities, a Gaussian belief per person) from the description, and I have no independent
// implementation to take golden vectors from. So it is tested by properties (monotone in rank, equal
// ranks equal results, bounded change, no NaN, order of input irrelevant) and not by someone else's
// numbers; do not describe it as "Elo-MMR" without that caveat.

const LOGISTIC_SCALE = Math.sqrt(3) / Math.PI; // a logistic with this scale has standard deviation 1
const BISECTION_STEPS = 60; // halves a ~10,000-point interval to far below a thousandth of a point
const SPAN_SCALES = 10; // how many scales past the extreme ratings the search interval reaches
const BIN_WIDTH_POINTS = 1; // opponents within one point of rating and spread are treated as one group

export interface RatingPrior {
    readonly userId: string;
    readonly mu: number;
    readonly sigma: number;
}

export interface RatingStanding {
    readonly userId: string;
    // 1-based, duplicated on ties (1, 1, 3): equal rank means the contest did not tell them apart.
    readonly rank: number;
}

export interface RatingResult {
    readonly userId: string;
    readonly rank: number;
    readonly muBefore: number;
    readonly muAfter: number;
    readonly sigmaAfter: number;
    readonly performance: number;
}

interface Contestant {
    readonly userId: string;
    readonly rank: number;
    readonly mu: number;
    readonly sigma: number; // after drift
    readonly scale: number; // logistic scale of this person as an opponent
}

interface Bin {
    readonly mu: number;
    readonly scale: number;
    count: number;
}

export function rateContest(
    priors: readonly RatingPrior[],
    standings: readonly RatingStanding[],
    parameters: RatingParameters,
): RatingResult[] {
    assert(standings.length >= 2, "a rating needs at least two contestants");
    assert(standings.length <= RATING_PARTICIPANTS_MAX, "the contest is within the rating bound");
    const contestants = prepare(priors, standings, parameters);
    const bins = binsOf(contestants);
    const below = countsBelow(contestants);
    const span = searchSpan(contestants);
    const results = contestants.map((c) => {
        const { lessThan, equal } = below.get(c.rank) ?? { lessThan: 0, equal: 0 };
        // Wins against everyone ranked after them, half a win per other contestant of equal rank.
        const target = lessThan + (equal - 1) * 0.5;
        const performance = fitPerformance(c, bins, target, span);
        return update(c, performance, parameters);
    });
    for (const r of results) assertFinite(r);
    return results.sort((a, b) => (a.userId < b.userId ? -1 : 1));
}

function prepare(
    priors: readonly RatingPrior[],
    standings: readonly RatingStanding[],
    parameters: RatingParameters,
): Contestant[] {
    const prior = new Map(priors.map((p) => [p.userId, p]));
    assert(prior.size === priors.length, "one prior per person");
    const seen = new Set<string>();
    const out = standings.map((s) => {
        assert(!seen.has(s.userId), "a person ranks once");
        seen.add(s.userId);
        assert(Number.isInteger(s.rank) && s.rank >= 1, "a rank is a positive integer");
        const p = prior.get(s.userId);
        assert(p !== undefined, "every contestant has a prior");
        assert(
            p.sigma > 0 && Number.isFinite(p.mu),
            "a prior is a finite rating with positive spread",
        );
        const sigma = Math.min(
            Math.sqrt(p.sigma ** 2 + parameters.driftSigma ** 2),
            parameters.sigmaInitial,
        );
        const scale = Math.sqrt(sigma ** 2 + parameters.performanceSpread ** 2) * LOGISTIC_SCALE;
        return { userId: s.userId, rank: s.rank, mu: p.mu, sigma, scale };
    });
    // Sorted by rank then id: the same contestants in any input order give the same arithmetic order.
    return out.sort((a, b) => a.rank - b.rank || (a.userId < b.userId ? -1 : 1));
}

// For each rank value: how many contestants rank strictly after, and how many share it.
function countsBelow(contestants: readonly Contestant[]) {
    const out = new Map<number, { lessThan: number; equal: number }>();
    let after = contestants.length;
    for (let i = 0; i < contestants.length; ) {
        const rank = contestants[i]?.rank ?? 0;
        let j = i;
        while (j < contestants.length && contestants[j]?.rank === rank) j++;
        after -= j - i;
        out.set(rank, { lessThan: after, equal: j - i });
        i = j;
    }
    return out;
}

// Opponents that are all but identical are counted together, which turns a field of thousands of new
// people (all the same prior) into a handful of terms.
function binsOf(contestants: readonly Contestant[]): Bin[] {
    const bins = new Map<string, Bin>();
    for (const c of contestants) {
        const mu = Math.round(c.mu / BIN_WIDTH_POINTS) * BIN_WIDTH_POINTS;
        const scale = Math.round(c.scale / BIN_WIDTH_POINTS) * BIN_WIDTH_POINTS;
        const key = `${mu}:${scale}`;
        const bin = bins.get(key) ?? { mu, scale, count: 0 };
        bin.count++;
        bins.set(key, bin);
    }
    return [...bins.values()];
}

function searchSpan(contestants: readonly Contestant[]): { low: number; high: number } {
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    let widest = 0;
    for (const c of contestants) {
        low = Math.min(low, c.mu);
        high = Math.max(high, c.mu);
        widest = Math.max(widest, c.scale);
    }
    return { low: low - SPAN_SCALES * widest, high: high + SPAN_SCALES * widest };
}

const logistic = (x: number) => 1 / (1 + Math.exp(-x));

// The expected number of wins of a player of strength `p` against the field, not counting themselves.
function expectedWins(self: Contestant, bins: readonly Bin[], p: number): number {
    let total = 0;
    for (const bin of bins) total += bin.count * logistic((p - bin.mu) / bin.scale);
    return total - logistic((p - self.mu) / self.scale);
}

// The strength at which the expected wins equal the wins the contestant actually had. The expected wins
// rise with strength, so bisection finds the one answer; the first and last place sit at the ends.
function fitPerformance(
    self: Contestant,
    bins: readonly Bin[],
    target: number,
    span: { low: number; high: number },
): number {
    let low = span.low;
    let high = span.high;
    for (let step = 0; step < BISECTION_STEPS; step++) {
        const middle = (low + high) / 2;
        if (expectedWins(self, bins, middle) < target) low = middle;
        else high = middle;
    }
    return (low + high) / 2;
}

function update(c: Contestant, performance: number, parameters: RatingParameters): RatingResult {
    const noise = parameters.performanceSpread ** 2;
    const precision = 1 / c.sigma ** 2 + 1 / noise;
    const mean = (c.mu / c.sigma ** 2 + performance / noise) / precision;
    const moved = Math.max(-parameters.changeMax, Math.min(parameters.changeMax, mean - c.mu));
    return {
        userId: c.userId,
        rank: c.rank,
        muBefore: c.mu,
        muAfter: c.mu + moved,
        sigmaAfter: Math.max(parameters.sigmaMin, Math.sqrt(1 / precision)),
        performance,
    };
}

function assertFinite(r: RatingResult): void {
    assert(
        Number.isFinite(r.muAfter) && Number.isFinite(r.sigmaAfter),
        "a rating is a finite number",
    );
    assert(Number.isFinite(r.performance), "a performance is a finite number");
}
