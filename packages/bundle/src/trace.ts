import { compareTag, decodeWatermark, type Files } from "./watermark.ts";

// The leak trace (Stage 4C, ADR 0030): given files that leaked, which deliveries could they have come from?
// Pure: the operator's tool reads the files and the delivery records and calls this. It names candidates
// and says how strong the evidence is; a person decides what to do with it.

export interface Candidate {
    readonly deliveryId: string;
    readonly taskVersionId: string;
    readonly tag: number;
}

export type Strength = "strong" | "possible";

export interface Match {
    readonly candidate: Candidate;
    readonly strength: Strength;
    // What the files said: bits of the answer mark that agree with the candidate, and solution files that
    // carry its tag exactly.
    readonly answerBitsAgreeing: number;
    readonly solutionMarks: number;
}

// Bits needed before agreement is evidence at all, and before it is strong: with n deliveries on record
// the chance that an unrelated tag agrees on k bits is about n / 2^k, so 24 bits keep a million
// deliveries under one chance in sixteen, and fewer than 8 say next to nothing.
export const BITS_POSSIBLE_MIN = 8;
export const BITS_STRONG_MIN = 24;
// Ones that must be read before a stretch of bits counts as a mark rather than as silence.
export const ONES_MIN = 2;

export interface Trace {
    // Bits of the answer mark the files held (0 when no answer file carried one).
    readonly answerBitsKnown: number;
    readonly solutionTags: readonly number[];
    readonly matches: readonly Match[];
}

export function traceLeak(files: Files, candidates: readonly Candidate[]): Trace {
    const decoded = decodeWatermark(files);
    // An answer mark is evidence only if it can be told from "no mark". Unmarked answers read as zeros all
    // the way, so a stretch of zeros says nothing, and a tag's marker bit (always 1) read as 0 means no
    // mark was ever written. A fragment too short to include the marker bit must at least show some ones.
    const markerBit = decoded.votes[31];
    const markerDenies = markerBit !== undefined && markerBit.ones < markerBit.zeros;
    const onesSeen = decoded.votes.filter((v) => v.ones > v.zeros).length;
    const hasAnswerMark = !markerDenies && onesSeen >= ONES_MIN;
    const matches: Match[] = [];
    for (const candidate of candidates) {
        const solutionMarks = decoded.solutionTags.filter((tag) => tag === candidate.tag).length;
        let agreeing = 0;
        let disagrees = false;
        if (hasAnswerMark) {
            const comparison = compareTag(decoded, candidate.tag);
            agreeing = comparison.known - comparison.wrong;
            disagrees = comparison.wrong > 0;
        }
        const answerStrength: Strength | null = disagrees
            ? null
            : agreeing >= BITS_STRONG_MIN
              ? "strong"
              : agreeing >= BITS_POSSIBLE_MIN
                ? "possible"
                : null;
        const strength: Strength | null = solutionMarks > 0 ? "strong" : answerStrength;
        if (strength !== null) {
            matches.push({ candidate, strength, answerBitsAgreeing: agreeing, solutionMarks });
        }
    }
    matches.sort((a, b) => rank(b) - rank(a));
    return {
        answerBitsKnown: hasAnswerMark ? decoded.votes.filter((v) => v.ones !== v.zeros).length : 0,
        solutionTags: decoded.solutionTags,
        matches,
    };
}

const rank = (match: Match) =>
    (match.strength === "strong" ? 1000 : 0) + match.solutionMarks * 100 + match.answerBitsAgreeing;
