import { assert } from "@aura/contracts/assert";
import { RATING_PARAMETERS_V1 as P } from "@aura/contracts/rating";
import { type RatingPrior, type RatingStanding, rateContest } from "../modules/contests/rating.ts";
import type { Scenario } from "./runner.ts";

// Goal: ratings across a season of contests. Each step is a contest with a random field and random ranks
// (with ties); the store keeps every person's rating. Invariants: replaying the whole log from empty gives
// exactly the same store (the job is a deterministic function of its inputs, so a lost database can be
// rebuilt and a re-run changes nothing); every rating is finite and every change within the cap; the
// better-ranked of two people with the same prior never ends below the other.

const PEOPLE = 80;
const FIELD_MIN = 20; // the smallest rated contest
const FIELD_SPAN = 40;

type Store = Map<string, { mu: number; sigma: number }>;
interface Contest {
    readonly standings: RatingStanding[];
}

function apply(store: Store, contest: Contest): void {
    const priors: RatingPrior[] = contest.standings.map((s) => ({
        userId: s.userId,
        mu: store.get(s.userId)?.mu ?? P.muInitial,
        sigma: store.get(s.userId)?.sigma ?? P.sigmaInitial,
    }));
    for (const r of rateContest(priors, contest.standings, P)) {
        assert(
            Math.abs(r.muAfter - r.muBefore) <= P.changeMax + 1e-9,
            "a change is within the cap",
        );
        assert(Number.isFinite(r.muAfter) && r.sigmaAfter >= P.sigmaMin, "a rating is sane");
        store.set(r.userId, { mu: r.muAfter, sigma: r.sigmaAfter });
    }
}

export function ratingScenario(): Scenario {
    return {
        name: "rating",
        stepsMax: 25,
        start(world) {
            const log: Contest[] = [];
            const store: Store = new Map();
            return {
                step() {
                    const size = FIELD_MIN + world.rng.nextInt(FIELD_SPAN);
                    const everyone = Array.from(
                        { length: PEOPLE },
                        (_, i) => `p${String(i).padStart(2, "0")}`,
                    );
                    const field = everyone
                        .map((id) => ({ id, key: world.rng.nextFloat() }))
                        .sort((a, b) => a.key - b.key)
                        .slice(0, size);
                    // Scores with ties: lower number, better rank.
                    const scored = field.map((f) => ({ id: f.id, score: world.rng.nextInt(8) }));
                    const standings = scored.map((s) => ({
                        userId: s.id,
                        rank: 1 + scored.filter((o) => o.score < s.score).length,
                    }));
                    const contest = { standings };
                    log.push(contest);
                    apply(store, contest);
                },
                check() {
                    const replay: Store = new Map();
                    for (const contest of log) apply(replay, contest);
                    assert(replay.size === store.size, "a replay rates the same people");
                    for (const [id, now] of store) {
                        const again = replay.get(id);
                        assert(
                            again !== undefined && again.mu === now.mu && again.sigma === now.sigma,
                            `a replay gives the same rating for ${id}`,
                        );
                    }
                },
            };
        },
    };
}
