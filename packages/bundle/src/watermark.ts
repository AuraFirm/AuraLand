// Per-delivery marks in a bundle's files (Stage 4C, ADR 0030). Pure: bytes in, bytes out, no I/O and no
// cryptography. The 32-bit tag comes from the control plane; this module only writes it into carriers
// where it cannot change what any participant's program does, and reads it back.
//
// Answer carrier: trailing spaces on jury answer lines. Participants never see answers, and the
// `tokens` and `float` checkers compare by whitespace-separated tokens, so spacing cannot matter.
// Solution carrier: a final comment line in each reference/wrong solution.

export const TAG_BITS = 32;
// The top bit of every tag is always 1. Without it an unmarked bundle (all answers unspaced) would read
// as the tag 0 and look like a mark; with it, "no mark" and "a mark" can be told apart. A tag therefore
// carries 31 bits of identity, ample for naming one delivery among many thousands.
export const TAG_MARKER = 0x80000000;
// Fewer lines than this and a bit would be written once or never: too fragile to count as a mark.
export const ANSWER_LINES_MIN = 64;
const MARK = "aura-wm:";
const ANSWER_FILE = /^tests\/([A-Za-z0-9][A-Za-z0-9_.-]*)\.ans$/;
const SOLUTION_FILE = /^solutions\/[^/]+\.(cpp|py)$/;
const MARK_LINE = /(?:\/\/|#) aura-wm:([0-9a-f]{8})\s*$/;

export type Files = ReadonlyMap<string, Uint8Array>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

// Text of a file, or null when it is not valid UTF-8 (such a file is left alone).
function textOf(bytes: Uint8Array): string | null {
    try {
        return decoder.decode(bytes);
    } catch {
        return null;
    }
}

// FNV-1a over the test id, reduced to a bit offset, so different tests start at different bits and a
// leak of any single large test still covers many of them.
function offsetOf(testId: string): number {
    let hash = 0x811c9dc5;
    for (const byte of encoder.encode(testId)) {
        hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    }
    return hash % TAG_BITS;
}

export interface Carriers {
    readonly answers: boolean;
    readonly solutions: boolean;
}

function answerLineCount(files: Files): number {
    let count = 0;
    for (const [path, bytes] of files) {
        if (!ANSWER_FILE.test(path)) continue;
        const text = textOf(bytes);
        if (text === null) return 0; // an answer we cannot read as text: do not touch any
        count += text.split("\n").filter((line) => line.replace(/\r$/, "").trim() !== "").length;
    }
    return count;
}

// Which carriers this bundle supports. `checkerType` is the spec's checker: only the whitespace-blind
// ones may have their answers marked.
export function carriersOf(files: Files, checkerType: string): Carriers {
    const whitespaceBlind = checkerType === "tokens" || checkerType === "float";
    return {
        answers: whitespaceBlind && answerLineCount(files) >= ANSWER_LINES_MIN,
        solutions: [...files.keys()].some((path) => SOLUTION_FILE.test(path)),
    };
}

function tagBit(tag: number, index: number): boolean {
    return ((tag >>> index) & 1) === 1;
}

function markAnswer(text: string, testId: string, tag: number): string {
    const offset = offsetOf(testId);
    let line = 0;
    return text
        .split("\n")
        .map((raw) => {
            const carriageReturn = raw.endsWith("\r") ? "\r" : "";
            const body = carriageReturn === "" ? raw : raw.slice(0, -1);
            if (body.trim() === "") return raw; // blank lines carry nothing and are left as they are
            line++;
            const clean = body.replace(/[ \t]+$/, "");
            return `${clean}${tagBit(tag, (line + offset) % TAG_BITS) ? " " : ""}${carriageReturn}`;
        })
        .join("\n");
}

const hex = (tag: number) => (tag >>> 0).toString(16).padStart(8, "0");

function markSolution(text: string, path: string, tag: number): string {
    const comment = path.endsWith(".py") ? "#" : "//";
    const stripped = text
        .split("\n")
        .filter((line) => !MARK_LINE.test(line))
        .join("\n")
        .replace(/\n*$/, "");
    return `${stripped}\n${comment} ${MARK}${hex(tag)}\n`;
}

export interface Embedded {
    readonly files: Map<string, Uint8Array>;
    readonly carriers: Carriers;
}

// Returns a copy of the files with the tag written into every carrier the bundle supports. Files that
// are not carriers are passed through as the same bytes.
export function embedWatermark(files: Files, tag: number, checkerType: string): Embedded {
    if (!Number.isInteger(tag) || tag < TAG_MARKER || tag >= 2 ** TAG_BITS) {
        throw new Error("a tag is a 32-bit unsigned integer with its top bit set");
    }
    const carriers = carriersOf(files, checkerType);
    const out = new Map<string, Uint8Array>();
    for (const [path, bytes] of files) {
        const text = textOf(bytes);
        const answerId = ANSWER_FILE.exec(path)?.[1];
        if (carriers.answers && answerId !== undefined && text !== null) {
            out.set(path, encoder.encode(markAnswer(text, answerId, tag)));
        } else if (carriers.solutions && SOLUTION_FILE.test(path) && text !== null) {
            out.set(path, encoder.encode(markSolution(text, path, tag)));
        } else {
            out.set(path, bytes);
        }
    }
    return { files: out, carriers };
}

export interface BitVotes {
    readonly ones: number;
    readonly zeros: number;
}

export interface Decoded {
    // Votes per bit index, from the answer carrier.
    readonly votes: readonly BitVotes[];
    // The tag when every bit has at least one vote and none is split; otherwise null.
    readonly answerTag: number | null;
    // Tags found in solution files (one per file that carried a mark).
    readonly solutionTags: readonly number[];
}

export function decodeWatermark(files: Files): Decoded {
    const ones = new Array<number>(TAG_BITS).fill(0);
    const zeros = new Array<number>(TAG_BITS).fill(0);
    const solutionTags: number[] = [];
    for (const [path, bytes] of files) {
        const text = textOf(bytes);
        if (text === null) continue;
        const answerId = ANSWER_FILE.exec(path)?.[1];
        if (answerId !== undefined) readAnswer(text, answerId, ones, zeros);
        else if (SOLUTION_FILE.test(path)) {
            const found = text.split("\n").map((line) => MARK_LINE.exec(line)?.[1]);
            for (const value of found)
                if (value !== undefined) solutionTags.push(Number.parseInt(value, 16));
        }
    }
    const votes = ones.map((one, index) => ({ ones: one, zeros: zeros[index] ?? 0 }));
    return { votes, answerTag: tagFromVotes(votes), solutionTags };
}

function readAnswer(text: string, testId: string, ones: number[], zeros: number[]): void {
    const offset = offsetOf(testId);
    let line = 0;
    for (const raw of text.split("\n")) {
        const body = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (body.trim() === "") continue;
        line++;
        const index = (line + offset) % TAG_BITS;
        // Exactly one trailing space is a one; none is a zero. Anything else (tabs, several spaces) is
        // not ours and is not counted either way.
        if (/[^ \t] $/.test(body)) ones[index] = (ones[index] ?? 0) + 1;
        else if (!/[ \t]$/.test(body)) zeros[index] = (zeros[index] ?? 0) + 1;
    }
}

function tagFromVotes(votes: readonly BitVotes[]): number | null {
    let tag = 0;
    for (const [index, vote] of votes.entries()) {
        // No vote, or a tie, leaves the bit unknown; one unknown bit means there is no whole tag.
        if (vote.ones === vote.zeros) return null;
        if (vote.ones > vote.zeros) tag |= 1 << index;
    }
    // No marker bit, no mark: an unmarked bundle reads as zeros everywhere.
    return (tag & TAG_MARKER) === 0 ? null : tag >>> 0;
}

// Does a candidate tag agree with everything the decoded files say? Bits with no votes are unknown and
// agree with anything; a bit whose majority differs from the candidate is a disagreement. Returns the
// number of bits known and the number that disagree, so a person can judge the match.
export function compareTag(decoded: Decoded, candidate: number): { known: number; wrong: number } {
    let known = 0;
    let wrong = 0;
    for (const [index, vote] of decoded.votes.entries()) {
        if (vote.ones === vote.zeros) continue;
        known++;
        if (vote.ones > vote.zeros !== tagBit(candidate, index)) wrong++;
    }
    return { known, wrong };
}
