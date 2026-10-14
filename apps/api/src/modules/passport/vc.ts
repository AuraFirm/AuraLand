import type { CredentialClaim } from "@aura/contracts/credentials";

// A credential as a VC-JWT in the Open Badges 3.0 profile (ADR 0033). The JWT claims follow the VC Data Model 1.1 JWT
// encoding (iss, sub, jti, nbf, exp, vc) because that is what verifiers implement today. Nothing here names an email,
// a per-test result or integrity evidence: the claim schema forbids it.

export interface CredentialInput {
    readonly id: string; // the credential's uuid
    readonly subject: string; // a uuid that names the holder only inside this credential
    readonly issuerDid: string;
    readonly issuerName: string;
    readonly keyId: string;
    readonly environment: "development" | "production";
    readonly claim: CredentialClaim;
    readonly assurance: number;
    readonly eventId: string;
    readonly issuedAtMs: number;
    readonly expiresAtMs: number | null;
    readonly status: { readonly listUrl: string; readonly index: number };
}

const OB_CONTEXT = "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json";
const VC_CONTEXT = "https://www.w3.org/2018/credentials/v1";

function achievement(claim: CredentialClaim, eventId: string, assurance: number) {
    const base = {
        id: `urn:uuid:${eventId}`,
        type: ["Achievement"],
        achievementType: "Certificate",
    };
    if (claim.kind === "contest_rank") {
        return {
            ...base,
            name: `Rank ${claim.rank} of ${claim.participants} in ${claim.event_title}`,
            description: `Solved ${claim.solved} problems in a contest hosted by ${claim.host_name}. Assurance level ${assurance}.`,
            criteria: { narrative: "Finished in the standings of a finalized, rated contest." },
        };
    }
    return {
        ...base,
        name: `Exam result in ${claim.event_title}`,
        description: `Scored ${claim.points_band} percent of the points in an exam hosted by ${claim.host_name} (${claim.ai_mode === "ai_free" ? "without AI assistance" : "AI assistance allowed and logged"}). Assurance level ${assurance}.`,
        criteria: { narrative: "Sat a timed exam whose grades were released by the host." },
    };
}

export function credentialPayload(input: CredentialInput) {
    const iso = (ms: number) => new Date(ms).toISOString();
    const vc = {
        "@context": [VC_CONTEXT, OB_CONTEXT],
        id: `urn:uuid:${input.id}`,
        type: ["VerifiableCredential", "OpenBadgeCredential"],
        issuer: { id: input.issuerDid, type: ["Profile"], name: input.issuerName },
        validFrom: iso(input.issuedAtMs),
        ...(input.expiresAtMs === null ? {} : { validUntil: iso(input.expiresAtMs) }),
        name: input.claim.event_title,
        credentialSubject: {
            id: `urn:uuid:${input.subject}`,
            type: ["AchievementSubject"],
            achievement: achievement(input.claim, input.eventId, input.assurance),
        },
        credentialStatus: {
            id: `${input.status.listUrl}#${input.status.index}`,
            type: "BitstringStatusListEntry",
            statusPurpose: "revocation",
            statusListIndex: String(input.status.index),
            statusListCredential: input.status.listUrl,
        },
    };
    return {
        iss: input.issuerDid,
        sub: `urn:uuid:${input.subject}`,
        jti: `urn:uuid:${input.id}`,
        nbf: Math.floor(input.issuedAtMs / 1000),
        ...(input.expiresAtMs === null ? {} : { exp: Math.floor(input.expiresAtMs / 1000) }),
        // Not part of the data model: says where the signing key lived, so a development credential is never
        // mistaken for a production one.
        aura_environment: input.environment,
        aura_assurance: input.assurance,
        vc,
    };
}

const b64url = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString("base64url");

// The bytes a signer signs: header and payload, each base64url, joined by a dot.
export function signingInput(input: CredentialInput): string {
    const header = { alg: "ES256", typ: "vc+jwt", kid: `${input.issuerDid}#${input.keyId}` };
    return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(credentialPayload(input)))}`;
}

export const assembleJwt = (signingText: string, signature: Uint8Array): string =>
    `${signingText}.${b64url(signature)}`;
