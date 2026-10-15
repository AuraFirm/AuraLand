import { createHash } from "node:crypto";
import type { VerifyResponse } from "@aura/contracts/api/passport";
import { CREDENTIAL_JWT_BYTES_MAX } from "@aura/contracts/limits";
import { z } from "zod";
import type { ObjectStorage } from "../../platform/object-storage.ts";
import type { PublicKey } from "./documents.ts";
import { credentialKey, JWKS_KEY, sharedKey, statusKey } from "./publish.ts";
import { isRevokedIn, verifyStatusList } from "./status-list.ts";
import { verifyCredentialJwt } from "./verify.ts";

// Public verification without the database (ADR 0033, kit 06 section 9): everything comes from the static files the
// worker published. If the database is down this still answers; if a file is missing the answer is "unknown" or
// "status not known", never a guess in the credential's favour.

const JWKS_BYTES_MAX = 64 * 1024;
const LIST_BYTES_MAX = 64 * 1024;

const jwksSchema = z.object({
    keys: z.array(
        z.object({
            kid: z.string(),
            alg: z.literal("ES256"),
            kty: z.string(),
            crv: z.string(),
            x: z.string(),
            y: z.string(),
        }),
    ),
});

async function readText(
    storage: ObjectStorage,
    key: string,
    bytesMax: number,
): Promise<string | null> {
    const found = await storage.getSmall(key, bytesMax);
    return found.kind === "found" ? new TextDecoder().decode(found.bytes) : null;
}

// Only keys that are published count; the file already leaves revoked keys out.
async function publishedKeys(storage: ObjectStorage): Promise<PublicKey[] | null> {
    const text = await readText(storage, JWKS_KEY, JWKS_BYTES_MAX);
    if (text === null) return null;
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return null;
    }
    const parsed = jwksSchema.safeParse(json);
    if (!parsed.success) return null;
    return parsed.data.keys.map((key) => ({
        kid: key.kid,
        alg: key.alg,
        status: "active",
        jwk: { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
    }));
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function verifyPublished(
    storage: ObjectStorage,
    input: { id: string; publicOrigin: string; nowMs: number; shareToken?: string | undefined },
): Promise<VerifyResponse> {
    const uuid = input.id.slice(input.id.indexOf("_") + 1);
    const jwt = await findJwt(storage, uuid, input);
    // A private credential and one that does not exist look the same on purpose.
    if (jwt === null) return { id: input.id, outcome: "unknown", status_known: false };
    const keys = await publishedKeys(storage);
    if (keys === null) {
        return {
            id: input.id,
            outcome: "unknown",
            status_known: false,
            reason: "the issuer's keys are not available",
        };
    }
    const result = await verifyCredentialJwt(jwt, keys, input.nowMs);
    if (result.outcome === "invalid") {
        return { id: input.id, outcome: "invalid", status_known: false, reason: result.reason };
    }
    if (result.credentialId !== uuid) {
        return {
            id: input.id,
            outcome: "invalid",
            status_known: false,
            reason: "this file belongs to another credential",
        };
    }
    const listNumber = listNumberOf(result.status.listUrl, input.publicOrigin);
    const revoked =
        listNumber === null
            ? null
            : await isRevoked(storage, keys, input.publicOrigin, listNumber, result.status.index);
    const known = revoked !== null;
    return {
        id: input.id,
        outcome: revoked === true ? "revoked" : result.outcome,
        status_known: known,
        ...(known ? {} : { reason: "whether it was revoked could not be checked" }),
        name: result.name,
        issuer: result.issuerName,
        description: result.achievement.description,
        assurance_level: result.assurance,
        ...(result.environment === "development" || result.environment === "production"
            ? { environment: result.environment }
            : {}),
        issued_at: iso(result.issuedAtMs),
        ...(result.expiresAtMs === null ? {} : { expires_at: iso(result.expiresAtMs) }),
        jwt,
    };
}

// The credential must point at one of our own lists: a credential that names a list at another address is not
// checked against it.
function listNumberOf(listUrl: string, publicOrigin: string): number | null {
    const prefix = `${publicOrigin}/api/public/status-lists/`;
    if (!listUrl.startsWith(prefix)) return null;
    const rest = listUrl.slice(prefix.length);
    return /^\d{1,6}$/.test(rest) ? Number(rest) : null;
}

// true or false when the list was read and verified; null when it could not be.
async function isRevoked(
    storage: ObjectStorage,
    keys: readonly PublicKey[],
    publicOrigin: string,
    list: number,
    index: number,
): Promise<boolean | null> {
    const jwt = await readText(storage, statusKey(list), LIST_BYTES_MAX);
    if (jwt === null) return null;
    const verified = await verifyStatusList(
        jwt,
        keys,
        `${publicOrigin}/api/public/status-lists/${list}`,
    );
    return verified.ok ? isRevokedIn(verified.bits, index) : null;
}

const sharedSchema = z.object({ jwt: z.string(), expires_at: z.iso.datetime() });

// A link's secret opens its file while the link lasts; failing that (or with no secret) only a public credential
// answers. A wrong or expired secret is not told apart from no secret.
async function findJwt(
    storage: ObjectStorage,
    uuid: string,
    input: { nowMs: number; shareToken?: string | undefined },
): Promise<string | null> {
    if (input.shareToken !== undefined) {
        const hash = createHash("sha256").update(input.shareToken).digest("hex");
        const text = await readText(storage, sharedKey(hash), CREDENTIAL_JWT_BYTES_MAX + 256);
        if (text !== null) {
            try {
                const parsed = sharedSchema.safeParse(JSON.parse(text));
                if (parsed.success && input.nowMs < Date.parse(parsed.data.expires_at))
                    return parsed.data.jwt;
            } catch {
                // an unreadable file is the same as no file
            }
        }
    }
    return readText(storage, credentialKey(uuid), CREDENTIAL_JWT_BYTES_MAX);
}
