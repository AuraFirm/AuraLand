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
