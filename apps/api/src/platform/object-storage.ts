import { assert } from "@aura/contracts/assert";
import { isUuidV7 } from "@aura/contracts/ids";

// The object storage port: the few operations the task bundle flow needs, and nothing else. Two
// adapters implement it (S3 and in-memory), and one contract test runs against both, so the memory
// adapter used by fast tests cannot drift from the real thing.
//
// Failure model: "not there" and "not finished" are values. Storage being unreachable or refusing us
// is an exception (StorageUnavailableError), which the route layer turns into a typed 503 so nothing
// is half-recorded.

export class StorageUnavailableError extends Error {
    constructor(operation: string, options?: ErrorOptions) {
        super(`object storage is unavailable during ${operation}`, options);
        this.name = "StorageUnavailableError";
    }
}

export interface PartUrlRequest {
    readonly key: string;
    readonly uploadId: string;
    // 1-based, as S3 numbers parts.
    readonly partNumber: number;
    // The exact size of this part. It is part of the signature, so a client cannot send more.
    readonly bytes: number;
    readonly lifetimeS: number;
}

export type MeasureResult =
    | { readonly kind: "missing" }
    | { readonly kind: "too_large" }
    | { readonly kind: "measured"; readonly bytes: number; readonly sha256: string };

export type CompleteResult =
    | { readonly kind: "completed" }
    // Parts are missing, or more or fewer than expected were uploaded. Nothing was assembled.
    | { readonly kind: "incomplete"; readonly partsFound: number };

export interface ObjectStorage {
    beginMultipart(key: string): Promise<string>;
    partUrl(request: PartUrlRequest): Promise<string>;
    // Assembles the object from the uploaded parts; the server lists them itself, so a client never
    // has to report (or lie about) part tags.
    completeMultipart(
        key: string,
        uploadId: string,
        partsExpected: number,
    ): Promise<CompleteResult>;
    abortMultipart(key: string, uploadId: string): Promise<void>;
    // Reads the object once, counting bytes and hashing them, and stops at `bytesMax`.
    measure(key: string, bytesMax: number): Promise<MeasureResult>;
    copy(fromKey: string, toKey: string): Promise<void>;
    remove(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

// Where an upload lands first. Nothing here is trusted: the hash has not been checked yet.
export function uploadKey(orgUuid: string, uploadUuid: string): string {
    assert(isUuidV7(orgUuid) && isUuidV7(uploadUuid), "keys are built from uuids only");
    return `uploads/${orgUuid}/${uploadUuid}`;
}

// The content-addressed home of a verified bundle. The organization is part of the key, so one
// organization can never read or overwrite another's object, and the hash makes it immutable.
export function bundleKey(orgUuid: string, sha256Hex: string): string {
    assert(isUuidV7(orgUuid), "keys are built from uuids only");
    assert(SHA256_HEX.test(sha256Hex), "a bundle key needs a lowercase sha-256 hex digest");
    return `bundles/${orgUuid}/${sha256Hex}`;
}
