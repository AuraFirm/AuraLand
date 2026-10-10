import { createHmac } from "node:crypto";
import { assert } from "@aura/contracts/assert";
import { makeUuidV7 } from "@aura/contracts/ids";
import type { Clock } from "../../platform/clock.ts";
import type { Rng } from "../../platform/rng.ts";
import {
    LOGIN_CODE_DIGITS,
    LOGIN_CODE_TTL_S,
    LOGIN_LINK_TTL_S,
    LOGIN_SECRET_BYTES,
} from "./limits.ts";

// Email sign-in building blocks: the secrets behind a challenge, how they are hashed, and the
// storage port. The use-cases (start, verify) and the routes build on these.

export interface ChallengeRecord {
    readonly id: string;
    readonly email: string;
    // Lowercase hex HMAC-SHA-256 values; the secrets themselves are never stored.
    readonly bindingHash: string;
    readonly linkHash: string;
    readonly codeHash: string;
    readonly createdAtMs: number;
    readonly linkExpiresAtMs: number;
    readonly codeExpiresAtMs: number;
    readonly codeAttempts: number;
    readonly consumedAtMs: number | null;
    readonly consumedBy: "link" | "code" | null;
}

// Result of counting one code guess. `consumed` means the guess was right and the challenge is now
// used up; otherwise `attempts` is how many guesses have now been spent.
export type CodeAttempt =
    | { readonly consumed: true; readonly email: string }
    | { readonly consumed: false; readonly attempts: number };

export interface ChallengeStore {
    insert(record: ChallengeRecord): Promise<void>;
    // Consumes the challenge through its link, once. Null unless the link matches this browser's
    // binding, the challenge is unused and the link has not expired.
    consumeWithLink(
        bindingHash: string,
        linkHash: string,
        nowMs: number,
    ): Promise<{ email: string } | null>;
    // Counts one guess for this browser's live challenge, and consumes it if the guess is right.
    // Null when there is nothing to guess against: no such challenge, already used, code expired,
    // or all attempts spent.
    tryCode(bindingHash: string, codeHash: string, nowMs: number): Promise<CodeAttempt | null>;
}

export type SecretKind = "link" | "code" | "binding";

const KEY_BYTES_MIN = 32;

// HMAC-SHA-256 under the server key, with the purpose mixed in so a value hashed for one purpose
// can never match a hash made for another.
export function hashSecret(key: Buffer, kind: SecretKind, value: string): string {
    assert(key.length >= KEY_BYTES_MIN, `login key must be at least ${KEY_BYTES_MIN} bytes`);
    return createHmac("sha256", key).update(`${kind}:${value}`).digest("hex");
}

const CODE_PATTERN = new RegExp(`^[0-9]{${LOGIN_CODE_DIGITS}}$`);

// Turns what a person typed into the canonical code, or null. Only ASCII digits, with spaces and
// hyphens ignored; nothing else is tolerated, so look-alike digits cannot slip through.
export function normalizeCode(input: string): string | null {
    const stripped = input.replace(/[\s-]/g, "");
    return CODE_PATTERN.test(stripped) ? stripped : null;
}

export function formatCode(code: string): string {
    assert(CODE_PATTERN.test(code), `code must be ${LOGIN_CODE_DIGITS} digits`);
    return `${code.slice(0, 4)} ${code.slice(4)}`;
}

export interface NewChallenge {
    readonly record: ChallengeRecord;
    readonly token: string; // goes in the emailed link
    readonly code: string; // goes in the email text
    readonly binding: string; // goes in the browser cookie
}

export interface ChallengeDeps {
    readonly clock: Clock;
    readonly rng: Rng;
    readonly key: Buffer;
}

const UUID_V7_RANDOM_BYTES = 10;

export function newChallenge(deps: ChallengeDeps, email: string): NewChallenge {
    assert(
        email === email.toLowerCase() && email.includes("@"),
        "email must already be normalized",
    );
    const nowMs = deps.clock.nowUnixMs();
    const token = Buffer.from(deps.rng.nextBytes(LOGIN_SECRET_BYTES)).toString("base64url");
    const binding = Buffer.from(deps.rng.nextBytes(LOGIN_SECRET_BYTES)).toString("base64url");
    // Uniform over 0 to 10^8 - 1, padded so leading zeros are real digits.
    const code = String(deps.rng.nextInt(10 ** LOGIN_CODE_DIGITS)).padStart(LOGIN_CODE_DIGITS, "0");
    const record: ChallengeRecord = {
        id: makeUuidV7(nowMs, deps.rng.nextBytes(UUID_V7_RANDOM_BYTES)),
        email,
        bindingHash: hashSecret(deps.key, "binding", binding),
        linkHash: hashSecret(deps.key, "link", token),
        codeHash: hashSecret(deps.key, "code", code),
        createdAtMs: nowMs,
        linkExpiresAtMs: nowMs + LOGIN_LINK_TTL_S * 1000,
        codeExpiresAtMs: nowMs + LOGIN_CODE_TTL_S * 1000,
        codeAttempts: 0,
        consumedAtMs: null,
        consumedBy: null,
    };
    return { record, token, code, binding };
}
