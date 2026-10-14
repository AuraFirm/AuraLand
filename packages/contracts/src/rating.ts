// Rating parameters (Stage 5, ADR 0031 decision 7). They are configuration, not scattered constants: the
// version number is stored with every rating run so a later change of values is visible in the history
// and never rewrites it. A different version is a new object here, not an edit of this one.

export const RATING_DIMENSION_CONTEST = "contest";

export const RATING_PARAMETERS_V1 = {
    version: 1,
    muInitial: 1500, // where a new person starts
    sigmaInitial: 350, // how unsure we are of a new person
    sigmaMin: 60, // never more certain than this, so ratings keep moving
    // Spread of one performance around a person's true strength. Larger: single contests count for less.
    performanceSpread: 200,
    // Added to the variance before each contest: people change, so old certainty decays.
    driftSigma: 25,
    // The most a rating may move in one contest, in rating points, either way.
    changeMax: 500,
} as const;
export type RatingParameters = typeof RATING_PARAMETERS_V1;

// Above this the pairwise fit is no longer cheap enough for one worker tick; such a contest needs the
// faster algorithm, which this stage does not build. The job refuses rather than run for minutes.
export const RATING_PARTICIPANTS_MAX = 20_000;

// Names and colors for rating ranges. The name carries the meaning; the color is decoration, so a page
// must always show the name (color alone fails people who cannot tell the colors apart).
export const RATING_TIERS = [
    { from: -Infinity, name: "Newcomer", color: "gray" },
    { from: 1200, name: "Apprentice", color: "green" },
    { from: 1400, name: "Adept", color: "teal" },
    { from: 1600, name: "Expert", color: "blue" },
    { from: 1900, name: "Master", color: "violet" },
    { from: 2100, name: "Grandmaster", color: "orange" },
    { from: 2400, name: "Legend", color: "red" },
] as const;
export type RatingTier = (typeof RATING_TIERS)[number];

// Fewer contests than this and the rating is still settling, which a page says.
export const RATING_PROVISIONAL_CONTESTS = 5;

export function ratingTierOf(rating: number): RatingTier {
    let tier: RatingTier = RATING_TIERS[0];
    for (const candidate of RATING_TIERS) if (rating >= candidate.from) tier = candidate;
    return tier;
}
