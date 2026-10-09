import { assert } from "./assert.ts";

// Limits shared by client and server. Every value has a unit and a reason; exceeding one is a
// typed error, never a silent truncation (docs/kit/02 section 2.2).

// Default JSON request body cap. Large enough for any form, small enough to stop memory abuse.
export const REQUEST_BODY_BYTES_MAX = 256 * 1024;

// Longest request id we accept from the trusted edge or generate ourselves.
export const REQUEST_ID_LENGTH_MAX = 64;

// ---- identity (Stage 1) ----

// RFC 5321 limits a mailbox path to 254 characters; longer addresses cannot be delivered.
export const EMAIL_LENGTH_MAX = 254;

// Handles are public and typed by people: short enough to read, long enough to be unique.
export const HANDLE_LENGTH_MIN = 3;
export const HANDLE_LENGTH_MAX = 24;

export const DISPLAY_NAME_LENGTH_MAX = 80;
export const ORG_NAME_LENGTH_MAX = 120;

// A slug appears in URLs; 3 to 40 characters keeps them memorable and bounded.
export const ORG_SLUG_LENGTH_MIN = 3;
export const ORG_SLUG_LENGTH_MAX = 40;

// Relationships between limits are checked when the module loads, so a bad edit fails at startup.
assert(HANDLE_LENGTH_MIN >= 1 && HANDLE_LENGTH_MIN < HANDLE_LENGTH_MAX, "handle length bounds");
assert(ORG_SLUG_LENGTH_MIN >= 3 && ORG_SLUG_LENGTH_MIN < ORG_SLUG_LENGTH_MAX, "slug length bounds");
assert(
    DISPLAY_NAME_LENGTH_MAX < ORG_NAME_LENGTH_MAX,
    "organization names may be longer than person names",
);
