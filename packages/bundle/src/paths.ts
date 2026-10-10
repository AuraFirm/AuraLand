import {
    BUNDLE_PATH_BYTES_MAX,
    BUNDLE_PATH_DEPTH_MAX,
    BUNDLE_PATH_SEGMENT_BYTES_MAX,
} from "@aura/contracts/limits";

// A path inside a bundle is a short, plain, relative name. Everything the tar format allows beyond
// that (absolute paths, "..", backslashes, NUL, empty segments, hidden files, non-ASCII, trailing
// slash) is refused by one allowlist, not by hunting for bad patterns.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeEntryPath(path: string): boolean {
    if (path.length === 0 || path.length > BUNDLE_PATH_BYTES_MAX) return false;
    const segments = path.split("/");
    if (segments.length > BUNDLE_PATH_DEPTH_MAX) return false;
    for (const segment of segments) {
        if (segment.length > BUNDLE_PATH_SEGMENT_BYTES_MAX || !SEGMENT.test(segment)) return false;
    }
    return true;
}
