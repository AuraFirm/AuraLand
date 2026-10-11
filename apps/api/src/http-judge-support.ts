import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    NODE_HEADER,
    NONCE_HEADER,
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
} from "@aura/contracts/judge-protocol";
import { START } from "./http-harness.ts";
import { canonicalText } from "./modules/judge/signing.ts";

// Test support for the judge-node protocol: an Ed25519 key pair and a function that signs a request
// the way the Go agent does.

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface TestKey {
    readonly seed: Buffer;
    readonly publicKey: Buffer;
    sign(text: string): Buffer;
}

export function keyFromSeed(seed: Buffer): TestKey {
    const privateKey = createPrivateKey({
        key: Buffer.concat([PKCS8_PREFIX, seed]),
        format: "der",
        type: "pkcs8",
    });
    const publicKey = createPublicKey(privateKey)
        .export({ format: "der", type: "spki" })
        .subarray(-32);
    return {
        seed,
        publicKey: Buffer.from(publicKey),
        sign: (text) => sign(null, Buffer.from(text), privateKey),
    };
}

export const newKey = (): TestKey => keyFromSeed(randomBytes(32));

export interface SignOptions {
    readonly nodeId: string;
    readonly key: TestKey;
    readonly nowMs: number;
    readonly nonce?: string;
    readonly timestampMs?: number;
}

// Headers and body for one signed request.
export function signedRequest(
    method: string,
    target: string,
    body: unknown,
    options: SignOptions,
): { headers: Record<string, string>; body: string } {
    const text = body === undefined ? "" : JSON.stringify(body);
    const nonce = options.nonce ?? randomBytes(18).toString("base64url");
    const timestampMs = options.timestampMs ?? options.nowMs;
    const signature = options.key.sign(
        canonicalText({ method, target, timestampMs, nonce, body: text }),
    );
    return {
        body: text,
        headers: {
            "content-type": "application/json",
            [NODE_HEADER]: options.nodeId,
            [TIMESTAMP_HEADER]: String(timestampMs),
            [NONCE_HEADER]: nonce,
            [SIGNATURE_HEADER]: signature.toString("base64url"),
        },
    };
}

// The shared signature vector for the Go agent (judge/fixtures/signature.json). Ed25519 is
// deterministic, so the same seed and request always give the same signature.
export const SIGNATURE_FIXTURE_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../judge/fixtures/signature.json",
);

export function signatureFixture() {
    const seed = Buffer.alloc(32, 7);
    const parts = {
        method: "POST",
        target: "/api/judge/v1/node/heartbeat",
        timestampMs: START,
        nonce: "bm9uY2Utbm9uY2Utbm9uY2U",
        body: '{"agent_version":"0.1.0","canary_ok":true,"running_jobs":0}',
    };
    const key = keyFromSeed(seed);
    return {
        seed_hex: seed.toString("hex"),
        public_key: key.publicKey.toString("base64url"),
        ...parts,
        canonical: canonicalText(parts),
        signature: key.sign(canonicalText(parts)).toString("base64url"),
    };
}
