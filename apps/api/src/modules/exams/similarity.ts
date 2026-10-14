import { assert } from "@aura/contracts/assert";

// Similarity between answers (Stage 6, slice 8): winnowing over normalized tokens. Pure, no I/O. The result is a
// signal for a person to read, never a verdict: two honest answers to a small problem can look alike.
//
// Normalizing makes renaming a variable, changing a number or a string, or rewriting comments change nothing, so
// copying with cosmetic edits still matches; changing the structure (order, control flow) does change it.

const GRAM_TOKENS = 5; // shorter grams match boilerplate, longer ones miss small edits
const WINDOW_GRAMS = 4; // guarantees any shared run of GRAM_TOKENS + WINDOW_GRAMS - 1 tokens is found
export const SIMILARITY_HOLDERS_MAX = 50; // a fingerprint in more answers than this is boilerplate, not copying
export const SIMILARITY_SOURCE_BYTES_MAX = 262_144;

const KEYWORDS = new Set(
    (
        "if else for while do switch case default break continue return goto int long short char float double void " +
        "unsigned signed const static struct class enum union typedef new delete this public private protected " +
        "def lambda import from as in is not and or pass yield with try except finally raise global nonlocal " +
        "using namespace template typename auto bool true false null nullptr None True False sizeof throw catch " +
        "final abstract interface extends implements package boolean byte var let"
    ).split(" "),
);

export interface Token {
    readonly text: string; // normalized: identifiers I, numbers N, strings S, everything else as written
    readonly start: number;
    readonly end: number; // exclusive
}
export interface Span {
    readonly start: number;
    readonly end: number;
}
interface Fingerprint {
    readonly hash: number;
    readonly tokenIndex: number;
}

// Comments and whitespace are skipped; the scanner moves forward every step, so it ends.
const SCANNER =
    /(?<skip>\s+|\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|(?<string>"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(?<number>\d[\w.]*)|(?<word>[A-Za-z_]\w*)|(?<other>[\s\S])/y;

export function tokenize(source: string): Token[] {
    assert(source.length <= SIMILARITY_SOURCE_BYTES_MAX, "source within the size limit");
    const tokens: Token[] = [];
    SCANNER.lastIndex = 0;
    for (let at = 0; at < source.length; ) {
        SCANNER.lastIndex = at;
        const found = SCANNER.exec(source);
        assert(
            found !== null && found.index === at,
            "the scanner always matches one more character",
        );
        const groups = found.groups ?? {};
        const end = at + found[0].length;
        if (groups["skip"] === undefined) {
            let text = found[0];
            if (groups["string"] !== undefined) text = "S";
            else if (groups["number"] !== undefined) text = "N";
            else if (groups["word"] !== undefined) text = KEYWORDS.has(text) ? text : "I";
            tokens.push({ text, start: at, end });
        }
        at = end;
    }
    return tokens;
}

function hashGram(tokens: Token[], from: number): number {
    let hash = 2166136261; // FNV-1a, 32 bits
    for (let i = from; i < from + GRAM_TOKENS; i++) {
        for (const char of `${tokens[i]?.text ?? ""} `) {
            hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
        }
    }
    return hash;
}

// In every window of WINDOW_GRAMS grams keep the smallest hash (the rightmost on ties), once per position.
export function fingerprints(tokens: Token[]): Fingerprint[] {
    const grams = tokens.length - GRAM_TOKENS + 1;
    if (grams < 1) return [];
    const hashes = Array.from({ length: grams }, (_, i) => hashGram(tokens, i));
    const kept: Fingerprint[] = [];
    let lastKept = -1;
    const windows = Math.max(1, grams - WINDOW_GRAMS + 1);
    for (let from = 0; from < windows; from++) {
        let best = from;
        for (let i = from; i < Math.min(from + WINDOW_GRAMS, grams); i++) {
            if ((hashes[i] ?? 0) <= (hashes[best] ?? 0)) best = i;
        }
        if (best !== lastKept) kept.push({ hash: hashes[best] ?? 0, tokenIndex: best });
        lastKept = best;
    }
    return kept;
}

export interface Prepared {
    readonly tokens: Token[];
    readonly prints: Fingerprint[];
}
export const prepare = (source: string): Prepared => {
    const tokens = tokenize(source);
    return { tokens, prints: fingerprints(tokens) };
};

function mergedSpans(spans: Span[]): Span[] {
    const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: Span[] = [];
    for (const span of sorted) {
        const last = merged[merged.length - 1];
        if (last !== undefined && span.start <= last.end) {
            merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
        } else merged.push(span);
    }
    return merged;
}

export interface Comparison {
    readonly score: number; // shared fingerprints over the smaller answer's, 0 to 1
    readonly shared: number;
    readonly spansA: Span[];
    readonly spansB: Span[];
}

export function compare(a: Prepared, b: Prepared): Comparison {
    const inB = new Map<number, Fingerprint[]>();
    for (const print of b.prints) inB.set(print.hash, [...(inB.get(print.hash) ?? []), print]);
    const spansA: Span[] = [];
    const spansB: Span[] = [];
    let shared = 0;
    const gramSpan = (p: Prepared, print: Fingerprint): Span => ({
        start: p.tokens[print.tokenIndex]?.start ?? 0,
        end: p.tokens[print.tokenIndex + GRAM_TOKENS - 1]?.end ?? 0,
    });
    for (const print of a.prints) {
        const matches = inB.get(print.hash);
        if (matches === undefined) continue;
        shared++;
        spansA.push(gramSpan(a, print));
        for (const match of matches) spansB.push(gramSpan(b, match));
    }
    const smaller = Math.min(a.prints.length, b.prints.length);
    assert(shared <= a.prints.length, "cannot share more than one has");
    return {
        score: smaller === 0 ? 0 : Math.min(1, shared / smaller),
        shared,
        spansA: mergedSpans(spansA),
        spansB: mergedSpans(spansB),
    };
}

export interface Pair {
    readonly a: number; // index into the answers given
    readonly b: number;
    readonly comparison: Comparison;
}

// Candidate pairs come from an inverted index, so only answers that share a fingerprint are ever compared.
export function similarPairs(
    sources: readonly string[],
    input: { scoreMin: number; pairsMax: number },
): Pair[] {
    assert(input.scoreMin > 0 && input.scoreMin <= 1, "scoreMin is in (0, 1]");
    const prepared = sources.map(prepare);
    const holders = new Map<number, number[]>();
    prepared.forEach((p, index) => {
        for (const print of p.prints) {
            const list = holders.get(print.hash) ?? [];
            if (list[list.length - 1] !== index) list.push(index);
            holders.set(print.hash, list);
        }
    });
    const candidates = new Set<number>();
    for (const list of holders.values()) {
        if (list.length > SIMILARITY_HOLDERS_MAX) continue;
        for (let i = 0; i < list.length; i++)
            for (let j = i + 1; j < list.length; j++)
                candidates.add((list[i] ?? 0) * sources.length + (list[j] ?? 0));
    }
    const pairs: Pair[] = [];
    for (const key of candidates) {
        const a = Math.floor(key / sources.length);
        const b = key % sources.length;
        const left = prepared[a];
        const right = prepared[b];
        assert(left !== undefined && right !== undefined, "a candidate names two answers");
        const comparison = compare(left, right);
        if (comparison.score >= input.scoreMin) pairs.push({ a, b, comparison });
    }
    pairs.sort((x, y) => y.comparison.score - x.comparison.score || x.a - y.a || x.b - y.b);
    return pairs.slice(0, input.pairsMax);
}
