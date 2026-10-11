import { createHash, createPublicKey, verify } from "node:crypto";
import { SIGNATURE_DOMAIN } from "@aura/contracts/judge-protocol";

// Request signing for judge nodes. A node signs a canonical text that binds the method, the exact
// path and query, a timestamp, a single-use nonce and the SHA-256 of the body, so a captured request
// cannot be replayed, redirected to another route or altered. The scheme is Ed25519 (deterministic,
// small keys, in `node:crypto`; no custom cryptography).

export interface SignedParts {
    readonly method: string;
    // Path and query exactly as sent, for example "/judge/v1/lease".
    readonly target: string;
    readonly timestampMs: number;
    readonly nonce: string;
    readonly body: string;
}

export function canonicalText(parts: SignedParts): string {
    const bodyHash = createHash("sha256").update(parts.body).digest("hex");
    return [
        SIGNATURE_DOMAIN,
        parts.method.toUpperCase(),
        parts.target,
        String(parts.timestampMs),
        parts.nonce,
        bodyHash,
    ].join("\n");
}

// An Ed25519 public key in SubjectPublicKeyInfo form is this fixed prefix plus the 32 raw bytes.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifySignature(
    publicKey: Uint8Array,
    parts: SignedParts,
    signature: Uint8Array,
): boolean {
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({
        key: Buffer.concat([SPKI_PREFIX, publicKey]),
        format: "der",
        type: "spki",
    });
    return verify(null, Buffer.from(canonicalText(parts)), key, signature);
}
