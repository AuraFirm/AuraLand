// Goal: an upload becomes a stored bundle only when the declared size and hash are exactly what
// arrived. Every wrong upload leaves no object at the content-addressed key, never disturbs an
// existing bundle, and storage faults leave the staging object so a retry works.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    bundleKey,
    type ObjectStorage,
    StorageUnavailableError,
    uploadKey,
} from "../../platform/object-storage.ts";
import { createMemoryStorage, type MemoryStorage } from "../../platform/storage-memory.ts";
import { createFakeClock } from "../../sim/world.ts";
import { type DeclaredBundle, verifyUpload } from "./upload-verify.ts";

const ORG = "018f0000-0000-7000-8000-0000000000a1";
const UPLOAD = "018f0000-0000-7000-8000-0000000000b1";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function stage(storage: MemoryStorage, parts: Uint8Array[]) {
    const stagingKey = uploadKey(ORG, UPLOAD);
    const uploadId = await storage.beginMultipart(stagingKey);
    for (const [index, part] of parts.entries()) {
        const url = await storage.partUrl({
            key: stagingKey,
            uploadId,
            partNumber: index + 1,
            bytes: part.length,
            lifetimeS: 60,
        });
        expect(storage.putPart(url, part)).toBe(true);
    }
    return { stagingKey, uploadId };
}

function setup(
    parts: Uint8Array[] = [new Uint8Array(randomBytes(30)), new Uint8Array(randomBytes(12))],
) {
    const storage = createMemoryStorage(createFakeClock(1_700_000_000_000));
    const whole = new Uint8Array(Buffer.concat(parts));
    return { storage, parts, whole };
}

async function declare(
    storage: MemoryStorage,
    parts: Uint8Array[],
    change: Partial<DeclaredBundle> = {},
) {
    const whole = new Uint8Array(Buffer.concat(parts));
    const { stagingKey, uploadId } = await stage(storage, parts);
    return {
        orgUuid: ORG,
        stagingKey,
        uploadId,
        partCount: parts.length,
        bytes: whole.length,
        sha256Hex: sha(whole),
        ...change,
    } satisfies DeclaredBundle;
}

describe("verifyUpload", () => {
    it("moves a matching upload to its content-addressed key and cleans up", async () => {
        const { storage, parts, whole } = setup();
        const declared = await declare(storage, parts);
        const result = await verifyUpload(storage, declared);
        expect(result).toEqual({ ok: true, bundleKey: bundleKey(ORG, sha(whole)) });
        expect(storage.read(bundleKey(ORG, sha(whole)))).toEqual(whole);
        expect(await storage.exists(declared.stagingKey)).toBe(false);
        expect(storage.objectCount()).toBe(1);
    });

    it("refuses a wrong hash, a wrong size and missing parts, leaving nothing at the target", async () => {
        const wrongHash = setup();
        const hashDeclared = await declare(wrongHash.storage, wrongHash.parts, {
            sha256Hex: "ab".repeat(32),
        });
        expect(await verifyUpload(wrongHash.storage, hashDeclared)).toEqual({
            ok: false,
            reason: "hash_mismatch",
        });
        expect(wrongHash.storage.objectCount()).toBe(0);

        const wrongSize = setup();
        const sizeDeclared = await declare(wrongSize.storage, wrongSize.parts, {
            bytes: wrongSize.whole.length + 1,
        });
        expect(await verifyUpload(wrongSize.storage, sizeDeclared)).toEqual({
            ok: false,
            reason: "size_mismatch",
        });
        expect(wrongSize.storage.objectCount()).toBe(0);

        const missing = setup();
        const missingDeclared = await declare(missing.storage, missing.parts, { partCount: 3 });
        expect(await verifyUpload(missing.storage, missingDeclared)).toEqual({
            ok: false,
            reason: "parts_missing",
        });
        expect(missing.storage.objectCount()).toBe(0);
    });
});

describe("verifyUpload, hostile and flaky cases", () => {
    it("cannot be used to overwrite an existing bundle by declaring its hash", async () => {
        const { storage, parts, whole } = setup();
        const first = await declare(storage, parts);
        await verifyUpload(storage, first);
        // A second upload declares the first bundle's hash but sends other bytes.
        const other = [new Uint8Array(randomBytes(50))];
        const forged = await declare(storage, other, {
            sha256Hex: sha(whole),
            bytes: whole.length,
        });
        expect(await verifyUpload(storage, forged)).toEqual({ ok: false, reason: "size_mismatch" });
        const sameSize = [new Uint8Array(randomBytes(whole.length))];
        const forgedSameSize = await declare(storage, sameSize, {
            sha256Hex: sha(whole),
            bytes: whole.length,
        });
        expect(await verifyUpload(storage, forgedSameSize)).toEqual({
            ok: false,
            reason: "hash_mismatch",
        });
        expect(storage.read(bundleKey(ORG, sha(whole)))).toEqual(whole);
    });

    it("treats a retry after success as the same success", async () => {
        const { storage, parts } = setup();
        const declared = await declare(storage, parts);
        const first = await verifyUpload(storage, declared);
        expect(first.ok).toBe(true);
        // The staging object is gone and the upload is closed: a second call has nothing to assemble.
        expect(await verifyUpload(storage, declared)).toEqual({
            ok: false,
            reason: "parts_missing",
        });
    });

    it("keeps the staging object when storage fails, so the call can be retried", async () => {
        const { storage, parts, whole } = setup();
        const declared = await declare(storage, parts);
        let failCopy = true;
        const flaky: ObjectStorage = {
            ...storage,
            copy: async (from, to) => {
                if (failCopy) throw new StorageUnavailableError("copy");
                return storage.copy(from, to);
            },
        };
        await expect(verifyUpload(flaky, declared)).rejects.toBeInstanceOf(StorageUnavailableError);
        expect(await storage.exists(bundleKey(ORG, sha(whole)))).toBe(false);
        expect(await storage.exists(declared.stagingKey)).toBe(true);
        failCopy = false;
        expect((await verifyUpload(flaky, declared)).ok).toBe(true);
    });
});
