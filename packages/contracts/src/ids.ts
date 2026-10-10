import { z } from "zod";
import { assert } from "./assert.ts";

// Public ids are `<prefix>_<uuid>`: the prefix says what the id names, so a user id can never be
// mistaken for an organization id, and the uuid is always a lowercase UUIDv7 (the database
// generates uuidv7 keys). Text from the outside is validated here before it reaches a query.

export const ID_PREFIXES = ["usr", "org", "ses", "key", "pky", "inv"] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(text: string): boolean {
    return UUID_V7.test(text);
}

const UUID_V7_RANDOM_BYTES = 10;
const UUID_V7_TIME_MAX = 2 ** 48; // The timestamp field has 48 bits.

// Builds a UUIDv7 from a time in unix milliseconds and ten random bytes, without touching the clock
// or a random source itself, so callers can inject both (docs/kit/02: inject Clock and Rng).
export function makeUuidV7(unixMs: number, random: Uint8Array): string {
    assert(
        Number.isSafeInteger(unixMs) && unixMs >= 0 && unixMs < UUID_V7_TIME_MAX,
        "time must fit in 48 bits",
    );
    assert(
        random.length === UUID_V7_RANDOM_BYTES,
        `UUIDv7 needs ${UUID_V7_RANDOM_BYTES} random bytes`,
    );
    const bytes = new Uint8Array(16);
    for (let index = 0; index < 6; index++) {
        // Big-endian 48-bit timestamp; division, not shifts, because shifts wrap at 32 bits.
        bytes[index] = Math.floor(unixMs / 2 ** (8 * (5 - index))) & 0xff;
    }
    bytes.set(random, 6);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodeId(prefix: IdPrefix, uuid: string): string {
    assert(isUuidV7(uuid), "uuid must be a lowercase UUIDv7");
    return `${prefix}_${uuid}`;
}

// Returns the bare uuid, or throws. Used where an id arrives from outside the system.
export function decodeId(prefix: IdPrefix, text: string): string {
    const marker = `${prefix}_`;
    assert(text.startsWith(marker), `id must have the prefix ${prefix}`);
    const uuid = text.slice(marker.length);
    assert(isUuidV7(uuid), "id must end in a lowercase UUIDv7");
    return uuid;
}

// A Zod schema for an id of one kind. The brand makes the type differ per prefix at compile time.
export function idSchema<P extends IdPrefix>(prefix: P) {
    return z
        .string()
        .regex(new RegExp(`^${prefix}_[0-9a-f-]{36}$`), `must be a ${prefix} id`)
        .refine((text) => isUuidV7(text.slice(prefix.length + 1)), "must contain a UUIDv7")
        .brand<P>();
}
