// Goal: the development signer behaves like the port promises, and cannot exist where credentials are real.
// Method: a signature verifies with the published public key and not with altered input or another key; the public
// key has no private member; staging and production refuse to build it.

import { createPublicKey, type JsonWebKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDevelopmentSigner } from "./signer.ts";

const input = new TextEncoder().encode("header.payload");
const verifies = (jwk: JsonWebKey, bytes: Uint8Array, signature: Uint8Array) =>
    verify(
        "sha256",
        bytes,
        { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
        signature,
    );

describe("development signer", () => {
    it("signs bytes that verify with its public key, and only those bytes", async () => {
        const signer = createDevelopmentSigner({ keyId: "dev-test-1", appEnvironment: "test" });
        const signature = await signer.sign(input);
        expect(signature.length).toBe(64);
        expect(verifies(signer.publicJwk(), input, signature)).toBe(true);
        expect(
            verifies(signer.publicJwk(), new TextEncoder().encode("header.payloaD"), signature),
        ).toBe(false);
        const other = createDevelopmentSigner({ keyId: "dev-test-2", appEnvironment: "local" });
        expect(verifies(other.publicJwk(), input, signature)).toBe(false);
    });

    it("publishes a public key only, and says it is a development key", () => {
        const signer = createDevelopmentSigner({ keyId: "dev-test-1", appEnvironment: "test" });
        expect(Object.keys(signer.publicJwk()).sort()).toEqual(["crv", "kty", "x", "y"]);
        expect(signer.environment).toBe("development");
        expect(signer.alg).toBe("ES256");
    });

    it("refuses to exist outside local and test, and with an odd key id", () => {
        for (const appEnvironment of ["staging", "prod", ""]) {
            expect(() => createDevelopmentSigner({ keyId: "dev-1", appEnvironment })).toThrow(
                /only in local and test/,
            );
        }
        expect(() => createDevelopmentSigner({ keyId: "a b", appEnvironment: "test" })).toThrow();
    });
});
