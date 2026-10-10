import { createHash, timingSafeEqual } from "node:crypto";
import { assert } from "@aura/contracts/assert";
import type { Rng } from "../../platform/rng.ts";

// API key format and checks. A key looks like `aura_<prefix>_<secret>`: the prefix (12 lowercase
// letters and digits) is public and finds the row; the secret (256 random bits) proves possession.
// Only SHA-256 of the secret is stored. A random 256-bit secret cannot be guessed offline, so a plain
// hash is enough; a slow password hash would only make every request slower.

export const API_KEY_MARK = "aura";
export const API_KEY_PREFIX_LENGTH = 12;
const SECRET_BYTES = 32;
const SECRET_TEXT_LENGTH = 43; // 32 bytes as unpadded base64url
const PREFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export const API_KEY_SCOPES = ["org:read"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface NewApiKey {
    // The only time the whole key exists; it is shown to the person once.
    readonly key: string;
    readonly prefix: string;
    readonly secretHash: string; // lowercase hex SHA-256
}

export function hashApiKeySecret(secret: string): string {
    return createHash("sha256").update(secret).digest("hex");
}

// Draws each prefix character with rejection sampling so all 36 letters and digits are equally likely.
function randomPrefix(rng: Rng): string {
    const limit = 252; // the largest multiple of 36 that fits in a byte
    let prefix = "";
    // unbounded: ends once enough bytes below the limit have been drawn, about 1.02 draws per character
    while (prefix.length < API_KEY_PREFIX_LENGTH) {
        for (const byte of rng.nextBytes(API_KEY_PREFIX_LENGTH)) {
            if (byte < limit && prefix.length < API_KEY_PREFIX_LENGTH) {
                prefix += PREFIX_ALPHABET[byte % PREFIX_ALPHABET.length];
            }
        }
    }
    return prefix;
}

export function newApiKey(rng: Rng): NewApiKey {
    const prefix = randomPrefix(rng);
    const secret = Buffer.from(rng.nextBytes(SECRET_BYTES)).toString("base64url");
    assert(secret.length === SECRET_TEXT_LENGTH, "secret has the expected length");
    return {
        key: `${API_KEY_MARK}_${prefix}_${secret}`,
        prefix,
        secretHash: hashApiKeySecret(secret),
    };
}

const KEY_PATTERN = new RegExp(
    `^${API_KEY_MARK}_([a-z0-9]{${API_KEY_PREFIX_LENGTH}})_([A-Za-z0-9_-]{${SECRET_TEXT_LENGTH}})$`,
);

export function parseApiKey(text: string): { prefix: string; secret: string } | null {
    const match = KEY_PATTERN.exec(text);
    if (match === null || match[1] === undefined || match[2] === undefined) return null;
    return { prefix: match[1], secret: match[2] };
}

// Compares in constant time, so response time does not reveal how many leading bytes matched.
export function secretMatches(secret: string, storedHashHex: string): boolean {
    const given = Buffer.from(hashApiKeySecret(secret), "hex");
    const stored = Buffer.from(storedHashHex, "hex");
    return given.length === stored.length && timingSafeEqual(given, stored);
}

// `Authorization: Bearer aura_...`, exactly one space, nothing else.
export function bearerKeyFrom(header: string | undefined): string | null {
    if (header === undefined || !header.startsWith("Bearer ")) return null;
    return header.slice("Bearer ".length);
}
