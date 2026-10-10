import { createHash } from "node:crypto";
import { assert } from "@aura/contracts/assert";
import {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CopyObjectCommand,
    CreateMultipartUploadCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    type GetObjectCommandOutput,
    HeadObjectCommand,
    ListPartsCommand,
    type ListPartsCommandOutput,
    S3Client,
    UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
    type CompleteResult,
    type MeasureResult,
    type ObjectStorage,
    type PartUrlRequest,
    StorageUnavailableError,
} from "./object-storage.ts";

// The S3 adapter (AWS in production, SeaweedFS locally; ADR 0025). It speaks to the storage server
// at `endpoint` and signs part URLs for the address browsers use, `publicEndpoint`, which can differ
// (an internal hostname versus a public one). Credentials come from configuration, never code.

export interface S3Settings {
    readonly region: string;
    readonly bucket: string;
    readonly endpoint: string;
    readonly publicEndpoint: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
}

// S3 lists at most 1,000 parts per call and a bundle has at most 100, so one page is all there is.
const PARTS_PAGE_SIZE = 1000;

function makeClient(settings: S3Settings, endpoint: string): S3Client {
    return new S3Client({
        region: settings.region,
        endpoint,
        // Path-style addressing works for every S3-compatible server without wildcard DNS.
        forcePathStyle: true,
        credentials: {
            accessKeyId: settings.accessKeyId,
            secretAccessKey: settings.secretAccessKey,
        },
        // The SDK's default adds checksum headers to every request, and a browser cannot send the
        // ones a presigned URL would then demand. Compute them only where the protocol requires.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        maxAttempts: 3,
    });
}

// Network and server faults become one typed error; our own bugs (assertions) pass through.
async function guarded<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (error) {
        throw new StorageUnavailableError(operation, { cause: error });
    }
}

function isNotFound(error: unknown): boolean {
    const name = error instanceof Error ? error.name : "";
    return name === "NotFound" || name === "NoSuchKey" || name === "NoSuchUpload";
}

interface Context {
    readonly internal: S3Client;
    readonly signer: S3Client;
    readonly bucket: string;
}

async function beginMultipart(context: Context, key: string): Promise<string> {
    const created = await context.internal.send(
        new CreateMultipartUploadCommand({ Bucket: context.bucket, Key: key }),
    );
    assert(created.UploadId !== undefined, "S3 returned an upload id");
    return created.UploadId;
}

function partUrl(context: Context, request: PartUrlRequest): Promise<string> {
    const command = new UploadPartCommand({
        Bucket: context.bucket,
        Key: request.key,
        UploadId: request.uploadId,
        PartNumber: request.partNumber,
        ContentLength: request.bytes,
    });
    // Signing content-length pins the part to its size.
    return getSignedUrl(context.signer, command, {
        expiresIn: request.lifetimeS,
        signableHeaders: new Set(["content-length"]),
    });
}

async function listParts(
    context: Context,
    key: string,
    uploadId: string,
): Promise<ListPartsCommandOutput | null> {
    try {
        return await context.internal.send(
            new ListPartsCommand({
                Bucket: context.bucket,
                Key: key,
                UploadId: uploadId,
                MaxParts: PARTS_PAGE_SIZE,
            }),
        );
    } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
    }
}

async function completeMultipart(
    context: Context,
    key: string,
    uploadId: string,
    partsExpected: number,
): Promise<CompleteResult> {
    const listed = await listParts(context, key, uploadId);
    if (listed === null) return { kind: "incomplete", partsFound: 0 };
    const parts = (listed.Parts ?? []).map((part) => ({
        PartNumber: part.PartNumber ?? 0,
        ETag: part.ETag ?? "",
    }));
    const consecutive = parts.every((part, index) => part.PartNumber === index + 1);
    if (!consecutive || parts.length !== partsExpected || listed.IsTruncated === true) {
        return { kind: "incomplete", partsFound: parts.length };
    }
    await context.internal.send(
        new CompleteMultipartUploadCommand({
            Bucket: context.bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
        }),
    );
    return { kind: "completed" };
}

async function abortMultipart(context: Context, key: string, uploadId: string): Promise<void> {
    try {
        await context.internal.send(
            new AbortMultipartUploadCommand({
                Bucket: context.bucket,
                Key: key,
                UploadId: uploadId,
            }),
        );
    } catch (error) {
        if (!isNotFound(error)) throw error;
    }
}

async function fetchObject(context: Context, key: string): Promise<GetObjectCommandOutput | null> {
    try {
        return await context.internal.send(
            new GetObjectCommand({ Bucket: context.bucket, Key: key }),
        );
    } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
    }
}

async function measure(context: Context, key: string, bytesMax: number): Promise<MeasureResult> {
    const response = await fetchObject(context, key);
    if (response === null) return { kind: "missing" };
    const body = response.Body;
    assert(body !== undefined, "S3 returned a body");
    const reader = body.transformToWebStream().getReader();
    if ((response.ContentLength ?? 0) > bytesMax) {
        await reader.cancel();
        return { kind: "too_large" };
    }
    const hash = createHash("sha256");
    let bytes = 0;
    // Bounded by bytesMax: the loop stops as soon as the cap is crossed.
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        bytes += chunk.value.length;
        if (bytes > bytesMax) {
            await reader.cancel();
            return { kind: "too_large" };
        }
        hash.update(chunk.value);
    }
    return { kind: "measured", bytes, sha256: hash.digest("hex") };
}

async function copy(context: Context, fromKey: string, toKey: string): Promise<void> {
    const source = `${context.bucket}/${encodeURIComponent(fromKey).replaceAll("%2F", "/")}`;
    await context.internal.send(
        new CopyObjectCommand({ Bucket: context.bucket, Key: toKey, CopySource: source }),
    );
}

async function exists(context: Context, key: string): Promise<boolean> {
    try {
        await context.internal.send(new HeadObjectCommand({ Bucket: context.bucket, Key: key }));
        return true;
    } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
    }
}

export function createS3Storage(settings: S3Settings): ObjectStorage {
    const context: Context = {
        internal: makeClient(settings, settings.endpoint),
        signer: makeClient(settings, settings.publicEndpoint),
        bucket: settings.bucket,
    };
    return {
        beginMultipart: (key) => guarded("beginMultipart", () => beginMultipart(context, key)),
        partUrl: (request) => guarded("partUrl", () => partUrl(context, request)),
        completeMultipart: (key, uploadId, partsExpected) =>
            guarded("completeMultipart", () =>
                completeMultipart(context, key, uploadId, partsExpected),
            ),
        abortMultipart: (key, uploadId) =>
            guarded("abortMultipart", () => abortMultipart(context, key, uploadId)),
        measure: (key, bytesMax) => guarded("measure", () => measure(context, key, bytesMax)),
        copy: (fromKey, toKey) => guarded("copy", () => copy(context, fromKey, toKey)),
        remove: (key) =>
            guarded("remove", async () => {
                await context.internal.send(
                    new DeleteObjectCommand({ Bucket: context.bucket, Key: key }),
                );
            }),
        exists: (key) => guarded("exists", () => exists(context, key)),
    };
}
