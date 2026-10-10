import { assert } from "@aura/contracts/assert";
import { BUNDLE_BYTES_MAX } from "@aura/contracts/limits";
import { bundleKey, type ObjectStorage } from "../../platform/object-storage.ts";

// Checks an uploaded bundle as bytes only (ADR 0022): the size and SHA-256 the uploader declared
// must equal what storage holds. The archive is never opened here; that happens in the sandbox in
// Stage 3. The object arrives under a staging key and moves to its content-addressed key only after
// the check passes, so a wrong upload can never replace a verified bundle.

export interface DeclaredBundle {
    readonly orgUuid: string;
    readonly stagingKey: string;
    readonly uploadId: string;
    readonly partCount: number;
    readonly bytes: number;
    readonly sha256Hex: string;
}

export type VerifyResult =
    | { readonly ok: true; readonly bundleKey: string }
    // What the person can fix: re-upload the missing parts, or start over.
    | { readonly ok: false; readonly reason: "parts_missing" | "size_mismatch" | "hash_mismatch" };

// Storage faults surface as StorageUnavailableError and leave nothing recorded: the staging object
// (or open upload) stays where it was, so the same call can be retried.
export async function verifyUpload(
    storage: ObjectStorage,
    declared: DeclaredBundle,
): Promise<VerifyResult> {
    assert(
        declared.bytes >= 1 && declared.bytes <= BUNDLE_BYTES_MAX,
        "declared size is within the cap",
    );
    const target = bundleKey(declared.orgUuid, declared.sha256Hex);

    // A retry after a crash between assembling and cleaning up finds the staging object already
    // assembled; completing again is then a harmless "incomplete", so look at the object first.
    if (!(await storage.exists(declared.stagingKey))) {
        const assembled = await storage.completeMultipart(
            declared.stagingKey,
            declared.uploadId,
            declared.partCount,
        );
        if (assembled.kind === "incomplete") return { ok: false, reason: "parts_missing" };
    }

    const measured = await storage.measure(declared.stagingKey, BUNDLE_BYTES_MAX);
    if (measured.kind === "missing") return { ok: false, reason: "parts_missing" };
    if (measured.kind === "too_large" || measured.bytes !== declared.bytes) {
        await storage.remove(declared.stagingKey);
        return { ok: false, reason: "size_mismatch" };
    }
    if (measured.sha256 !== declared.sha256Hex) {
        await storage.remove(declared.stagingKey);
        return { ok: false, reason: "hash_mismatch" };
    }

    // Verified. An existing object at the target already has this hash (it was verified when it was
    // stored), so it is left alone rather than rewritten.
    if (!(await storage.exists(target))) await storage.copy(declared.stagingKey, target);
    await storage.remove(declared.stagingKey);
    return { ok: true, bundleKey: target };
}
