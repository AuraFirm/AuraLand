// The public documents that let anyone check a credential without us (ADR 0033): the issuer's DID document and the
// key set. Pure: they are built from the keys the database lists, and published as static files.

export interface PublicKey {
    readonly kid: string;
    readonly alg: "ES256" | "EdDSA";
    readonly status: "active" | "retired" | "revoked";
    // A public key only. EC keys have x and y; an Ed25519 key would have no y.
    readonly jwk: {
        readonly kty: string;
        readonly crv: string;
        readonly x: string;
        readonly y?: string;
    };
}

// did:web:host (a port's colon is written %3A). The origin is the validated public origin of the site.
export function issuerDid(origin: string): string {
    const url = new URL(origin);
    return `did:web:${url.host.replace(":", "%3A")}`;
}

// A revoked key is left out on purpose: its credentials must stop verifying. Retired keys stay, so credentials
// signed before a rotation still verify.
const publishable = (keys: readonly PublicKey[]) => keys.filter((key) => key.status !== "revoked");

export function didDocument(did: string, keys: readonly PublicKey[]) {
    const methods = publishable(keys).map((key) => ({
        id: `${did}#${key.kid}`,
        type: "JsonWebKey2020",
        controller: did,
        publicKeyJwk: { ...key.jwk, kid: key.kid },
    }));
    return {
        "@context": [
            "https://www.w3.org/ns/did/v1",
            "https://w3id.org/security/suites/jws-2020/v1",
        ],
        id: did,
        verificationMethod: methods,
        assertionMethod: methods.map((method) => method.id),
    };
}

export function jwks(keys: readonly PublicKey[]) {
    return {
        keys: publishable(keys).map((key) => ({
            ...key.jwk,
            kid: key.kid,
            alg: key.alg,
            use: "sig",
        })),
    };
}
