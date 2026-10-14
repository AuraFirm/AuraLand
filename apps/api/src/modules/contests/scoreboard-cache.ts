// Rendered scoreboard responses, kept by the etag they were made from. Found by load measurement (slice 14):
// without it every read of a 2,000-row board re-parsed and re-serialized hundreds of kilobytes, and a start
// spike of readers saturated the process. Reads now ask the database only for the board's etag (a few bytes);
// the text is built once per etag and served from memory until the board changes. Nothing here is per
// person: the policy check on the etag read is what decides who may have the text.

import { gzipSync } from "node:zlib";

export const SCOREBOARD_CACHE_BYTES_MAX = 64 * 1024 * 1024; // all cached texts together
export const SCOREBOARD_CACHE_ENTRIES_MAX = 256; // two views of 128 contests; far above a live day

export interface RenderCache {
    get(key: string, etag: string): string | null;
    // The same text gzipped, made once per etag on first ask: JSON of a board compresses about tenfold, and a
    // spike of readers is bytes on the wire, not work in the process.
    gzipped(key: string, etag: string): Uint8Array<ArrayBuffer> | null;
    set(key: string, etag: string, text: string): void;
    size(): number;
}

export function createRenderCache(
    bytesMax: number = SCOREBOARD_CACHE_BYTES_MAX,
    entriesMax: number = SCOREBOARD_CACHE_ENTRIES_MAX,
): RenderCache {
    const entries = new Map<
        string,
        { etag: string; text: string; gzip: Uint8Array<ArrayBuffer> | null }
    >();
    let bytes = 0;
    const drop = (key: string) => {
        const old = entries.get(key);
        if (old === undefined) return;
        bytes -= old.text.length;
        entries.delete(key);
    };
    return {
        get(key, etag) {
            const entry = entries.get(key);
            return entry !== undefined && entry.etag === etag ? entry.text : null;
        },
        gzipped(key, etag) {
            const entry = entries.get(key);
            if (entry === undefined || entry.etag !== etag) return null;
            entry.gzip ??= new Uint8Array(gzipSync(entry.text));
            return entry.gzip;
        },
        set(key, etag, text) {
            drop(key);
            if (text.length > bytesMax) return; // too big to keep: served, just not cached
            entries.set(key, { etag, text, gzip: null });
            bytes += text.length;
            // Oldest first: a Map iterates in insertion order. The loop ends because each pass removes one.
            for (const oldest of entries.keys()) {
                if (bytes <= bytesMax && entries.size <= entriesMax) break;
                drop(oldest);
            }
        },
        size: () => entries.size,
    };
}
