// Limits shared by client and server. Every value has a unit and a reason; exceeding one is a
// typed error, never a silent truncation (docs/kit/02 section 2.2).

// Default JSON request body cap. Large enough for any form, small enough to stop memory abuse.
export const REQUEST_BODY_BYTES_MAX = 256 * 1024;

// Longest request id we accept from the trusted edge or generate ourselves.
export const REQUEST_ID_LENGTH_MAX = 64;
