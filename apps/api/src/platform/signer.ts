import { generateKeyPairSync, sign } from "node:crypto";
import { assert } from "@aura/contracts/assert";

// The only door to a credential signing key (kit 08, ADR 0033). The application holds a key id and asks for
// signatures over bytes; it never sees a private key. In production the adapter is a KMS (not built: there is no
// account to run it against, cutlist F62). The adapter here keeps a key in this process's memory, which is fine for
// development and tests and nothing else, so it refuses to exist anywhere else.

export interface Signer {
    readonly keyId: string;
    readonly alg: "ES256";
    // Where this signer's credentials come from; verification pages show it so a development credential is never
    // mistaken for a production one.
    readonly environment: "development" | "production";
    // The public half, as a JWK without any private member.
    publicJwk(): {
        readonly kty: string;
        readonly crv: string;
        readonly x: string;
        readonly y: string;
    };
    // A JWS ES256 signature (64 bytes, r then s) over the signing input.
    sign(input: Uint8Array): Promise<Uint8Array>;
}

const ES256_SIGNATURE_BYTES = 64;

export function createDevelopmentSigner(input: { keyId: string; appEnvironment: string }): Signer {
    // Fail loudly: a signer that holds a key in memory must never run where credentials are real.
    assert(
        input.appEnvironment === "local" || input.appEnvironment === "test",
        "the development signer runs only in local and test environments",
    );
    assert(/^[A-Za-z0-9._-]{3,64}$/.test(input.keyId), "a key id is a short plain word");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const exported = publicKey.export({ format: "jwk" });
    assert(
        exported.kty === "EC" &&
            exported.crv === "P-256" &&
            exported.x !== undefined &&
            exported.y !== undefined,
        "a P-256 public key has x and y",
    );
    const jwk = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y };
    return {
        keyId: input.keyId,
        alg: "ES256",
        environment: "development",
        publicJwk: () => jwk,
        sign: async (bytes) => {
            // IEEE P1363 is the encoding JWS requires (not the DER that openssl prints by default).
            const signature = sign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" });
            assert(signature.length === ES256_SIGNATURE_BYTES, "an ES256 signature is 64 bytes");
            return new Uint8Array(signature);
        },
    };
}
