import { z } from "zod";
import { assert } from "./assert.ts";

// Public ids are `<prefix>_<uuid>`: the prefix says what the id names, so a user id can never be
// mistaken for an organization id, and the uuid is always a lowercase UUIDv7 (the database
// generates uuidv7 keys). Text from the outside is validated here before it reaches a query.

export const ID_PREFIXES = ["usr", "org", "ses", "key", "pky"] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(text: string): boolean {
    return UUID_V7.test(text);
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
