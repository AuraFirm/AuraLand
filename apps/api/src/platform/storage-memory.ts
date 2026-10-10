import { createHash } from "node:crypto";
import { assert } from "@aura/contracts/assert";
import type { Clock } from "./clock.ts";
import type {
    CompleteResult,
    MeasureResult,
    ObjectStorage,
    PartUrlRequest,
} from "./object-storage.ts";

// In-memory object storage for tests and simulation. Never used by the running service: the
// configuration loader refuses it outside test environments. Part "URLs" are opaque handles that
// `putPart` honours the way S3 honours a presigned URL: until they expire, for the signed size only.

interface Upload {
    readonly key: string;
    readonly parts: Map<number, Uint8Array>;
}

interface Handle {
    readonly request: PartUrlRequest;
    readonly expiresAtMs: number;
}

export interface MemoryStorage extends ObjectStorage {
    // What a client does with a presigned URL. Returns false when S3 would refuse it.
    putPart(url: string, bytes: Uint8Array): boolean;
    // Test inspection and tampering.
    read(key: string): Uint8Array | undefined;
    write(key: string, bytes: Uint8Array): void;
    objectCount(): number;
    uploadCount(): number;
}

interface State {
    readonly clock: Clock;
    readonly objects: Map<string, Uint8Array>;
    readonly uploads: Map<string, Upload>;
    readonly handles: Map<string, Handle>;
    counter: number;
}

function partUrl(state: State, request: PartUrlRequest): string {
    const upload = state.uploads.get(request.uploadId);
    assert(upload !== undefined && upload.key === request.key, "the upload exists for this key");
    assert(request.partNumber >= 1 && request.partNumber <= 10_000, "S3 part numbers");
    state.counter++;
    const url = `memory://part/${state.counter}`;
    const expiresAtMs = state.clock.nowUnixMs() + request.lifetimeS * 1000;
    state.handles.set(url, { request, expiresAtMs });
    return url;
}

function putPart(state: State, url: string, bytes: Uint8Array): boolean {
    const handle = state.handles.get(url);
    if (handle === undefined || state.clock.nowUnixMs() >= handle.expiresAtMs) return false;
    if (bytes.length !== handle.request.bytes) return false;
    const upload = state.uploads.get(handle.request.uploadId);
    if (upload === undefined) return false;
    upload.parts.set(handle.request.partNumber, Uint8Array.from(bytes));
    return true;
}

function complete(state: State, key: string, uploadId: string, expected: number): CompleteResult {
    const upload = state.uploads.get(uploadId);
    if (upload === undefined || upload.key !== key) return { kind: "incomplete", partsFound: 0 };
    const numbers = [...upload.parts.keys()].sort((a, b) => a - b);
    const consecutive = numbers.every((number, index) => number === index + 1);
    if (!consecutive || numbers.length !== expected) {
        return { kind: "incomplete", partsFound: numbers.length };
    }
    const joined = Buffer.concat(numbers.map((n) => upload.parts.get(n) ?? new Uint8Array()));
    state.objects.set(key, new Uint8Array(joined));
    state.uploads.delete(uploadId);
    return { kind: "completed" };
}

function measure(state: State, key: string, bytesMax: number): MeasureResult {
    const object = state.objects.get(key);
    if (object === undefined) return { kind: "missing" };
    if (object.length > bytesMax) return { kind: "too_large" };
    return {
        kind: "measured",
        bytes: object.length,
        sha256: createHash("sha256").update(object).digest("hex"),
    };
}

export function createMemoryStorage(clock: Clock): MemoryStorage {
    const state: State = {
        clock,
        objects: new Map(),
        uploads: new Map(),
        handles: new Map(),
        counter: 0,
    };
    return {
        async beginMultipart(key) {
            state.counter++;
            const uploadId = `mem-upload-${state.counter}`;
            state.uploads.set(uploadId, { key, parts: new Map() });
            return uploadId;
        },
        partUrl: async (request) => partUrl(state, request),
        putPart: (url, bytes) => putPart(state, url, bytes),
        completeMultipart: async (key, uploadId, expected) =>
            complete(state, key, uploadId, expected),
        abortMultipart: async (_key, uploadId) => void state.uploads.delete(uploadId),
        measure: async (key, bytesMax) => measure(state, key, bytesMax),
        async copy(fromKey, toKey) {
            const object = state.objects.get(fromKey);
            assert(object !== undefined, "copy needs an existing source");
            state.objects.set(toKey, object);
        },
        remove: async (key) => void state.objects.delete(key),
        exists: async (key) => state.objects.has(key),
        read: (key) => state.objects.get(key),
        write: (key, bytes) => void state.objects.set(key, Uint8Array.from(bytes)),
        objectCount: () => state.objects.size,
        uploadCount: () => state.uploads.size,
    };
}
