// Every way a bundle can be refused, as a closed set. Callers switch on the code; the detail is for
// people and never contains bundle content. The corpus names the code each malformed file must get.
export const BUNDLE_ERROR_CODES = [
    "empty", // zero bytes
    "too_large", // packed or unpacked size over its cap
    "bad_compression", // not valid zstd, or truncated zstd
    "compression_ratio", // unpacks to more than 100 times its packed size
    "truncated", // the tar ends inside a header, a file or before its trailer
    "bad_checksum", // a header's checksum field does not match its bytes
    "non_canonical_header", // a header differs from the one our writer would produce
    "bad_padding", // bytes after a file's data, up to the next block, are not zero
    "bad_trailer", // not exactly two zero blocks at the end
    "unsupported_entry", // not a regular file: link, device, directory, extended header
    "unsafe_path", // absolute, traversal, NUL, backslash, empty or oversized segment, too deep
    "duplicate_path", // the same path twice, also when only the letter case differs
    "unsorted_entries", // entries are not in byte order of their paths
    "too_many_entries", // more than 5,000 entries
    "file_too_large", // one file over its cap
    "missing_file", // a required file, or a file the spec names, is absent
    "unexpected_file", // a file the layout does not allow, or one nothing refers to
    "bad_spec_json", // task.json is not UTF-8 JSON, or too large
    "invalid_spec", // task.json parses but is not a valid TaskSpec
    "bad_statement", // the statement is not UTF-8, empty or too large
] as const;

export type BundleErrorCode = (typeof BUNDLE_ERROR_CODES)[number];

export interface BundleError {
    readonly code: BundleErrorCode;
    // Which path or field, when there is one. Never file contents.
    readonly detail: string;
}

export type BundleResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: BundleError };

export function fail<T = never>(code: BundleErrorCode, detail: string): BundleResult<T> {
    return { ok: false, error: { code, detail } };
}

export function succeed<T>(value: T): BundleResult<T> {
    return { ok: true, value };
}
