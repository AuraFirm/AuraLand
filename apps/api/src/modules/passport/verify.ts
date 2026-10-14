import type { CredentialClaim } from "@aura/contracts/credentials";
import { CREDENTIAL_JWT_BYTES_MAX } from "@aura/contracts/limits";
import { compactVerify, decodeProtectedHeader, errors, importJWK } from "jose";
import { z } from "zod";
import type { PublicKey } from "./documents.ts";

// Checks a credential the way any verifier would: the signature against the published keys, then the dates. It
// reads only the JWT and the key set (both static files), never the database. Whether the credential was revoked is
// a separate check against the status list, made by the caller.

export type Verified =
    | {
          readonly outcome: "valid" | "expired";
          readonly credentialId: string;
          readonly kid: string;
          readonly environment: string;
          readonly assurance: number;
          readonly expiresAtMs: number | null;
          readonly issuedAtMs: number;
          readonly status: { readonly listUrl: string; readonly index: number };
          readonly name: string;
      }
    | { readonly outcome: "invalid"; readonly reason: string };

const payloadSchema = z.object({
    iss: z.string(),
    jti: z.string().regex(/^urn:uuid:[0-9a-f-]{36}$/),
    nbf: z.number().int(),
    exp: z.number().int().optional(),
    aura_environment: z.string(),
    aura_assurance: z.number().int(),
    vc: z.object({
        name: z.string(),
        credentialStatus: z.object({
            statusListCredential: z.string(),
            statusListIndex: z.string().regex(/^\d{1,9}$/),
        }),
    }),
});

const invalid = (reason: string): Verified => ({ outcome: "invalid", reason });

export async function verifyCredentialJwt(
    jwt: string,
    keys: readonly PublicKey[],
    nowMs: number,
): Promise<Verified> {
    if (jwt.length > CREDENTIAL_JWT_BYTES_MAX) return invalid("too large");
    let kid: string;
    try {
        const header = decodeProtectedHeader(jwt);
        if (header.alg !== "ES256" || typeof header.kid !== "string")
            return invalid("unsupported header");
        kid = header.kid.split("#").pop() ?? "";
    } catch {
        return invalid("not a JWT");
    }
    const key = keys.find((candidate) => candidate.kid === kid && candidate.status !== "revoked");
    if (key === undefined) return invalid("unknown or revoked key");
    let payloadText: string;
    try {
        const imported = await importJWK({ ...key.jwk, alg: "ES256" }, "ES256");
        const result = await compactVerify(jwt, imported, { algorithms: ["ES256"] });
        payloadText = new TextDecoder().decode(result.payload);
    } catch (error) {
        if (error instanceof errors.JWSSignatureVerificationFailed)
            return invalid("signature does not match");
        return invalid("cannot be verified");
    }
    return readVerified(payloadText, kid, nowMs);
}

function readVerified(payloadText: string, kid: string, nowMs: number): Verified {
    let json: unknown;
    try {
        json = JSON.parse(payloadText);
    } catch {
        return invalid("payload is not JSON");
    }
    const parsed = payloadSchema.safeParse(json);
    if (!parsed.success) return invalid("payload has the wrong shape");
    const p = parsed.data;
    const status = p.vc.credentialStatus;
    const expiresAtMs = p.exp === undefined ? null : p.exp * 1000;
    const notYet = nowMs < p.nbf * 1000;
    if (notYet) return invalid("not valid yet");
    return {
        outcome: expiresAtMs !== null && nowMs >= expiresAtMs ? "expired" : "valid",
        credentialId: p.jti.slice("urn:uuid:".length),
        kid,
        environment: p.aura_environment,
        assurance: p.aura_assurance,
        expiresAtMs,
        issuedAtMs: p.nbf * 1000,
        status: { listUrl: status.statusListCredential, index: Number(status.statusListIndex) },
        name: p.vc.name,
    };
}

export type { CredentialClaim };
