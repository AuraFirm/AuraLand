import { gunzipSync, gzipSync } from "node:zlib";
import { assert } from "@aura/contracts/assert";
import { STATUS_LIST_ENTRIES } from "@aura/contracts/limits";
import { z } from "zod";
import type { Signer } from "../../platform/signer.ts";
import type { PublicKey } from "./documents.ts";
import { verifySignature } from "./verify.ts";

// The revocation list (ADR 0033): one bit per credential, set exactly when the credential is revoked, published as a
// signed credential. Bit 0 is the most significant bit of the first byte, as the W3C Bitstring Status List specifies.

const LIST_BYTES = STATUS_LIST_ENTRIES / 8;

export function encodeStatusList(revoked: Iterable<number>): string {
    const bits = new Uint8Array(LIST_BYTES);
    for (const index of revoked) {
        assert(
            Number.isInteger(index) && index >= 0 && index < STATUS_LIST_ENTRIES,
            "an index within the list",
        );
        bits[index >> 3] = (bits[index >> 3] ?? 0) | (0x80 >> (index & 7));
    }
    return `u${gzipSync(bits).toString("base64url")}`;
}

// null when the text is not a list this module could have written; a size cap stops a compression bomb.
export function readStatusList(encoded: string): Uint8Array | null {
    if (!encoded.startsWith("u")) return null;
    try {
        const bits = gunzipSync(Buffer.from(encoded.slice(1), "base64url"), {
            maxOutputLength: LIST_BYTES,
        });
        return bits.length === LIST_BYTES ? new Uint8Array(bits) : null;
    } catch {
        return null;
    }
}

export function isRevokedIn(bits: Uint8Array, index: number): boolean {
    assert(index >= 0 && index < STATUS_LIST_ENTRIES, "an index within the list");
    return ((bits[index >> 3] ?? 0) & (0x80 >> (index & 7))) !== 0;
}

const b64url = (value: string | Uint8Array): string => Buffer.from(value).toString("base64url");

export interface StatusListInput {
    readonly listUrl: string;
    readonly issuerDid: string;
    readonly encodedList: string;
    readonly issuedAtMs: number;
}

// The list as a VC-JWT: if the file could be replaced without a signature, "not revoked" could be forged.
export async function signStatusList(signer: Signer, input: StatusListInput): Promise<string> {
    const payload = {
        iss: input.issuerDid,
        jti: input.listUrl,
        sub: `${input.listUrl}#list`,
        nbf: Math.floor(input.issuedAtMs / 1000),
        vc: {
            "@context": ["https://www.w3.org/2018/credentials/v1"],
            id: input.listUrl,
            type: ["VerifiableCredential", "BitstringStatusListCredential"],
            issuer: input.issuerDid,
            validFrom: new Date(input.issuedAtMs).toISOString(),
            credentialSubject: {
                id: `${input.listUrl}#list`,
                type: "BitstringStatusList",
                statusPurpose: "revocation",
                encodedList: input.encodedList,
            },
        },
    };
    const header = { alg: "ES256", typ: "vc+jwt", kid: `${input.issuerDid}#${signer.keyId}` };
    const text = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = await signer.sign(new TextEncoder().encode(text));
    return `${text}.${b64url(signature)}`;
}

const listPayload = z.object({
    jti: z.string(),
    vc: z.object({
        credentialSubject: z.object({
            encodedList: z.string(),
            statusPurpose: z.literal("revocation"),
        }),
    }),
});

// A list that checks out, or the reason it does not. A caller must treat any failure as "status unknown", never as
// "not revoked".
export async function verifyStatusList(
    jwt: string,
    keys: readonly PublicKey[],
    expectedUrl: string,
): Promise<{ ok: true; bits: Uint8Array } | { ok: false; reason: string }> {
    const signed = await verifySignature(jwt, keys);
    if (!signed.ok) return signed;
    let json: unknown;
    try {
        json = JSON.parse(signed.payloadText);
    } catch {
        return { ok: false, reason: "payload is not JSON" };
    }
    const parsed = listPayload.safeParse(json);
    if (!parsed.success) return { ok: false, reason: "payload has the wrong shape" };
    if (parsed.data.jti !== expectedUrl) return { ok: false, reason: "this is another list" };
    const bits = readStatusList(parsed.data.vc.credentialSubject.encodedList);
    return bits === null ? { ok: false, reason: "the list cannot be read" } : { ok: true, bits };
}
