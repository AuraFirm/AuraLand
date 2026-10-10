import {
    uploadPlanSchema,
    type VersionItem,
    versionSchema,
} from "@aura/contracts/api/task-versions";
import { apiSend } from "./api.ts";

// Uploads a bundle the way the API plans it: hash the file, ask for a plan, send each part straight to
// storage (the API never sees the bytes), then ask the API to check and record it. The server verifies
// size and hash itself; the hash computed here only tells it what to expect.

export interface Range {
    readonly start: number;
    readonly end: number;
}

// The byte range of each part, in order. Parts are consecutive and cover the file exactly.
export function partRanges(parts: readonly { readonly bytes: number }[]): Range[] {
    const ranges: Range[] = [];
    let start = 0;
    for (const part of parts) {
        ranges.push({ start, end: start + part.bytes });
        start += part.bytes;
    }
    return ranges;
}

export async function sha256Hex(blob: Blob): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function uploadBundle(
    versionId: string,
    file: File,
    onProgress: (text: string) => void,
): Promise<VersionItem> {
    onProgress("Checking the file…");
    const sha256 = await sha256Hex(file);
    const plan = await apiSend(`/task-versions/${versionId}/uploads`, uploadPlanSchema, {
        method: "POST",
        body: { bytes: file.size, sha256 },
    });
    const ranges = partRanges(plan.parts);
    if (ranges[ranges.length - 1]?.end !== file.size)
        throw new Error("The upload plan does not match the file");
    for (const [index, part] of plan.parts.entries()) {
        onProgress(`Uploading part ${index + 1} of ${plan.parts.length}…`);
        const range = ranges[index];
        if (range === undefined) throw new Error("missing part range");
        const response = await fetch(part.url, {
            method: "PUT",
            body: file.slice(range.start, range.end),
            credentials: "omit",
            cache: "no-store",
        });
        if (!response.ok) throw new Error(`Part ${index + 1} was refused by storage`);
    }
    onProgress("Verifying…");
    return apiSend(`/task-versions/${versionId}/finalize`, versionSchema, {
        method: "POST",
        body: { upload_id: plan.upload_id },
    });
}
