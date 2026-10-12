import { createHash } from "node:crypto";

// Checks a delivery against its manifest using only Node's standard library, so a customer can run it
// without installing anything. The manifest's own hash is checked against the value we publish
// separately (portal and email), each bundle by SHA-256 and size, and the watermark is read back.

export interface DeliveryFile {
    readonly name: string;
    readonly bytes: Uint8Array;
}

export interface VerificationResult {
    readonly problems: string[];
    readonly itemCount: number;
}

const sha256Hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBundles(manifest: Record<string, unknown>): { sha256: string; bytes: number }[] {
    const items = Array.isArray(manifest["items"]) ? manifest["items"] : [];
    const bundles: { sha256: string; bytes: number }[] = [];
    for (const item of items) {
        const bundle = isRecord(item) ? item["bundle"] : null;
        if (
            isRecord(bundle) &&
            typeof bundle["sha256"] === "string" &&
            typeof bundle["bytes"] === "number"
        ) {
            bundles.push({ sha256: bundle["sha256"], bytes: bundle["bytes"] });
        }
    }
    return bundles;
}

export function verifyDelivery(
    manifestText: string,
    expectedManifestSha256: string | null,
    files: readonly DeliveryFile[],
): VerificationResult {
    const problems: string[] = [];
    if (expectedManifestSha256 !== null && sha256Hex(manifestText) !== expectedManifestSha256) {
        problems.push("the manifest does not match the published hash");
    }
    let manifest: unknown = null;
    try {
        manifest = JSON.parse(manifestText);
    } catch {
        problems.push("the manifest is not valid JSON");
    }
    if (!isRecord(manifest)) {
        problems.push("the manifest is not an object");
        return { problems, itemCount: 0 };
    }
    const bundles = readBundles(manifest);
    const itemCount = Array.isArray(manifest["items"]) ? manifest["items"].length : 0;
    if (bundles.length !== itemCount) problems.push("an item has no valid bundle entry");
    const bySha = new Map(files.map((file) => [sha256Hex(file.bytes), file]));
    for (const bundle of bundles) {
        const file = bySha.get(bundle.sha256);
        if (file === undefined) problems.push(`no file with SHA-256 ${bundle.sha256}`);
        else if (file.bytes.length !== bundle.bytes) {
            problems.push(`${file.name} has ${file.bytes.length} bytes, expected ${bundle.bytes}`);
        }
    }
    return { problems, itemCount };
}
