// Goal: the in-memory and S3 adapters behave the same, so tests and simulation that use the memory
// adapter say something true about the real one. One suite, run against both. The S3 side needs the
// local server from infra/compose.yml (AURA_TEST_S3_ENDPOINT); it fails, not skips, without it.
import { createHash, randomBytes } from "node:crypto";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeClock } from "../sim/world.ts";
import {
    bundleKey,
    type ObjectStorage,
    StorageUnavailableError,
    uploadKey,
} from "./object-storage.ts";
import { createMemoryStorage } from "./storage-memory.ts";
import { createS3Storage } from "./storage-s3.ts";
import { s3TestSettings } from "./test-helpers.ts";

const MIB = 1024 * 1024;
const ORG = "018f0000-0000-7000-8000-0000000000a1";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface Subject {
    readonly name: string;
    readonly storage: ObjectStorage;
    // Sends bytes to a presigned URL the way a browser would; true when accepted.
    put(url: string, bytes: Uint8Array): Promise<boolean>;
    // Lets a short-lived URL expire.
    pass(seconds: number): Promise<void>;
}

async function memorySubject(): Promise<Subject> {
    const clock = createFakeClock(1_700_000_000_000);
    const storage = createMemoryStorage(clock);
    return {
        name: "memory",
        storage,
        put: async (url, bytes) => storage.putPart(url, bytes),
        pass: async (seconds) => clock.advance(seconds * 1000),
    };
}

async function s3Subject(): Promise<Subject> {
    const settings = s3TestSettings("aura-test");
    const admin = new S3Client({
        region: settings.region,
        endpoint: settings.endpoint,
        forcePathStyle: true,
        credentials: {
            accessKeyId: settings.accessKeyId,
            secretAccessKey: settings.secretAccessKey,
        },
    });
    // One shared bucket: the local server reserves volumes per bucket, so a bucket per run would
    // exhaust it. Keys are unique per upload, and re-creating an owned bucket is fine.
    await admin.send(new CreateBucketCommand({ Bucket: settings.bucket })).catch((error: Error) => {
        if (error.name !== "BucketAlreadyOwnedByYou" && error.name !== "BucketAlreadyExists")
            throw error;
    });
    return {
        name: "s3",
        storage: createS3Storage(settings),
        put: async (url, bytes) => (await fetch(url, { method: "PUT", body: bytes })).ok,
        pass: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
    };
}

const subjects: Subject[] = [];
beforeAll(async () => {
    subjects.push(await memorySubject(), await s3Subject());
});
afterAll(() => undefined);

let counter = 0;
const RUN = randomBytes(4).toString("hex");
const freshUploadKey = () =>
    uploadKey(
        ORG,
        `018f0000-0000-7000-8${RUN.slice(0, 3)}-${RUN}${String(++counter).padStart(4, "0")}`,
    );

async function uploadParts(subject: Subject, key: string, sizes: number[], skip: number[] = []) {
    const uploadId = await subject.storage.beginMultipart(key);
    const chunks = sizes.map((size) => new Uint8Array(randomBytes(size)));
    for (const [index, chunk] of chunks.entries()) {
        if (skip.includes(index + 1)) continue;
        const url = await subject.storage.partUrl({
            key,
            uploadId,
            partNumber: index + 1,
            bytes: chunk.length,
            lifetimeS: 60,
        });
        expect(await subject.put(url, chunk), `part ${index + 1}`).toBe(true);
    }
    return { uploadId, whole: new Uint8Array(Buffer.concat(chunks)) };
}

describe.each(["memory", "s3"])("object storage contract: %s", (name) => {
    const subject = () => {
        const found = subjects.find((s) => s.name === name);
        if (found === undefined) throw new Error("subject not ready");
        return found;
    };

    it("assembles a multipart upload and measures its size and hash", async () => {
        const { storage } = subject();
        const key = freshUploadKey();
        const { uploadId, whole } = await uploadParts(subject(), key, [8 * MIB, 8 * MIB, 1 * MIB]);
        expect(await storage.completeMultipart(key, uploadId, 3)).toEqual({ kind: "completed" });
        expect(await storage.measure(key, 64 * MIB)).toEqual({
            kind: "measured",
            bytes: whole.length,
            sha256: sha256(whole),
        });
    });

    it("copies to a content-addressed key, and removes", async () => {
        const { storage } = subject();
        const key = freshUploadKey();
        const { uploadId, whole } = await uploadParts(subject(), key, [8 * MIB, 3]);
        await storage.completeMultipart(key, uploadId, 2);
        const target = bundleKey(ORG, sha256(whole));
        expect(await storage.exists(target)).toBe(false);
        await storage.copy(key, target);
        expect(await storage.exists(target)).toBe(true);
        await storage.remove(key);
        expect(await storage.exists(key)).toBe(false);
        expect((await storage.measure(target, 64 * MIB)).kind).toBe("measured");
    });
});

describe.each(["memory", "s3"])("object storage contract, failure cases: %s", (name) => {
    const subject = () => {
        const found = subjects.find((s) => s.name === name);
        if (found === undefined) throw new Error("subject not ready");
        return found;
    };

    it("does not assemble when a part is missing or the count is wrong", async () => {
        const { storage } = subject();
        const gap = freshUploadKey();
        const first = await uploadParts(subject(), gap, [8 * MIB, 8 * MIB, 5], [2]);
        expect(await storage.completeMultipart(gap, first.uploadId, 3)).toEqual({
            kind: "incomplete",
            partsFound: 2,
        });
        expect(await storage.exists(gap)).toBe(false);
        const short = freshUploadKey();
        const second = await uploadParts(subject(), short, [8 * MIB, 5]);
        expect(await storage.completeMultipart(short, second.uploadId, 3)).toEqual({
            kind: "incomplete",
            partsFound: 2,
        });
    });

    it("refuses a part of a different size than the URL was signed for", async () => {
        const { storage } = subject();
        const key = freshUploadKey();
        const uploadId = await storage.beginMultipart(key);
        const url = await storage.partUrl({
            key,
            uploadId,
            partNumber: 1,
            bytes: 100,
            lifetimeS: 60,
        });
        expect(await subject().put(url, new Uint8Array(101))).toBe(false);
        expect(await subject().put(url, new Uint8Array(99))).toBe(false);
        expect(await subject().put(url, new Uint8Array(100))).toBe(true);
    });
});

describe.each(["memory", "s3"])("object storage contract, limits: %s", (name) => {
    const subject = () => {
        const found = subjects.find((s) => s.name === name);
        if (found === undefined) throw new Error("subject not ready");
        return found;
    };

    it("refuses a part URL after it has expired", async () => {
        const { storage } = subject();
        const key = freshUploadKey();
        const uploadId = await storage.beginMultipart(key);
        const url = await storage.partUrl({
            key,
            uploadId,
            partNumber: 1,
            bytes: 10,
            lifetimeS: 1,
        });
        await subject().pass(2.5);
        expect(await subject().put(url, new Uint8Array(10))).toBe(false);
    });

    it("answers missing and too large as values", async () => {
        const { storage } = subject();
        expect(await storage.measure(freshUploadKey(), MIB)).toEqual({ kind: "missing" });
        const key = freshUploadKey();
        const { uploadId } = await uploadParts(subject(), key, [8 * MIB, 8 * MIB]);
        await storage.completeMultipart(key, uploadId, 2);
        expect(await storage.measure(key, 8 * MIB)).toEqual({ kind: "too_large" });
    });

    it("forgets an aborted upload", async () => {
        const { storage } = subject();
        const key = freshUploadKey();
        const { uploadId } = await uploadParts(subject(), key, [8 * MIB, 5]);
        await storage.abortMultipart(key, uploadId);
        expect((await storage.completeMultipart(key, uploadId, 2)).kind).toBe("incomplete");
        await storage.abortMultipart(key, uploadId);
    });
});

describe("storage failures", () => {
    it("reports an unreachable server as a typed error", async () => {
        const storage = createS3Storage({
            region: "us-east-1",
            bucket: "nothing",
            endpoint: "http://127.0.0.1:1",
            publicEndpoint: "http://127.0.0.1:1",
            accessKeyId: "x",
            secretAccessKey: "y",
        });
        await expect(storage.exists("bundles/x")).rejects.toBeInstanceOf(StorageUnavailableError);
    });

    it("builds keys from uuids and digests only", () => {
        const digest = "a".repeat(64);
        expect(bundleKey(ORG, digest)).toBe(`bundles/${ORG}/${digest}`);
        expect(() => bundleKey(ORG, "../x")).toThrow();
        expect(() => bundleKey("not-a-uuid", digest)).toThrow();
        expect(() => uploadKey(ORG, "../../etc")).toThrow();
    });
});
