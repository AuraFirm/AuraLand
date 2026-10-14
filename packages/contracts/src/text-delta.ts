// A text change as one replacement: delete `remove` characters at `start` and put `insert` there. A replay of a
// sitting is a base text and a chain of these, so the timeline is small and exact (Stage 6, slice 7). Pure.
// Positions count UTF-16 code units, like JavaScript strings, and are aligned to whole code points so a surrogate
// pair is never split between a step's retained text and its inserted text.

export interface TextDelta {
    readonly start: number;
    readonly remove: number;
    readonly insert: string;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// The smallest single replacement that turns `before` into `after`: common prefix and common suffix are kept.
export function diffText(before: string, after: string): TextDelta {
    const max = Math.min(before.length, after.length);
    let prefix = 0;
    while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
    // Do not end the prefix between the two halves of a surrogate pair.
    if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix--;
    let suffix = 0;
    while (
        suffix < max - prefix &&
        before.charCodeAt(before.length - 1 - suffix) ===
            after.charCodeAt(after.length - 1 - suffix)
    ) {
        suffix++;
    }
    // Nor start the suffix in the middle of a pair.
    if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix--;
    return {
        start: prefix,
        remove: before.length - prefix - suffix,
        insert: after.slice(prefix, after.length - suffix),
    };
}

export function applyDelta(text: string, delta: TextDelta): string {
    if (delta.start < 0 || delta.remove < 0 || delta.start + delta.remove > text.length) {
        throw new Error("a text change names a place outside the text");
    }
    return text.slice(0, delta.start) + delta.insert + text.slice(delta.start + delta.remove);
}
