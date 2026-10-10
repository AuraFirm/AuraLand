// Session limits. Each has a unit and a reason (docs/kit/02 section 2.2).

// 256 bits: infeasible to guess, and the token is hashed before storage.
export const SESSION_TOKEN_BYTES = 32;

// People who can change other people's data must sign in again sooner when idle.
export const SESSION_IDLE_TIMEOUT_S_PRIVILEGED = 30 * 60;
export const SESSION_IDLE_TIMEOUT_S_STANDARD = 7 * 24 * 60 * 60;

// No session lives longer than this, however active (docs/kit/08 section 3).
export const SESSION_ABSOLUTE_TIMEOUT_S = 30 * 24 * 60 * 60;

// Keeps the session list readable and bounds the damage of a stolen device list.
export const SESSIONS_PER_USER_MAX = 20;

// Activity extends a session at most once per interval, so reading a page does not write a row.
export const SESSION_TOUCH_INTERVAL_S = 60;

// How recently a passkey check must have happened to count as a fresh second factor.
export const STEP_UP_FRESH_S = 15 * 60;

// A browser sends at most 4 KiB of cookies; a token is 43 characters, so anything longer is junk.
export const SESSION_TOKEN_TEXT_LENGTH = 43;

// Browsers send at most about 4 KiB of cookies per site; a longer Cookie header is not from a browser.
export const COOKIE_HEADER_BYTES_MAX = 4096;

// Unsafe requests must carry this header. A cross-site page cannot add a custom header without a
// CORS preflight, and we answer none, so its presence proves the request came from our own script.
export const CSRF_HEADER_NAME = "x-aura-request";
export const CSRF_HEADER_VALUE = "1";

// ---- email sign-in ----

// The sign-in link is valid for 15 minutes; the typed code for 10, because a short code is the
// easier thing to guess and so gets the shorter life.
export const LOGIN_LINK_TTL_S = 15 * 60;
export const LOGIN_CODE_TTL_S = 10 * 60;

// Eight decimal digits: 10^8 possibilities, with only five guesses allowed per challenge.
export const LOGIN_CODE_DIGITS = 8;
export const LOGIN_CODE_ATTEMPTS_MAX = 5;

// 256 bits for the link token and for the value kept in the browser cookie.
export const LOGIN_SECRET_BYTES = 32;

// Starting a sign-in is limited per address and per email; guessing codes is limited per address.
// Windows are fixed (see platform/rate-limit.ts). Values follow docs/stages/stage-1-plan.md.
export const LOGIN_START_PER_EMAIL_PER_HOUR_MAX = 5;
export const LOGIN_START_PER_ADDRESS_PER_MINUTE_MAX = 10;
export const LOGIN_VERIFY_PER_ADDRESS_PER_MINUTE_MAX = 30;

// ---- passkeys ----

// A registration or login challenge is valid for 5 minutes: long enough for a person to find a
// security key, short enough that a stolen challenge is useless soon.
export const WEBAUTHN_CHALLENGE_TTL_S = 5 * 60;
export const WEBAUTHN_CHALLENGE_BYTES = 32;

// Matches the database cap; more than this is clutter, not safety.
export const PASSKEYS_PER_USER_MAX = 20;

// Passkey login is anonymous and each attempt writes a challenge row, so it is limited per address.
export const PASSKEY_LOGIN_PER_ADDRESS_PER_MINUTE_MAX = 30;

// ---- OAuth sign-in ----

// A person has ten minutes to approve at the provider and come back; the database caps it too.
export const OAUTH_FLOW_TTL_S = 10 * 60;
export const OAUTH_SECRET_BYTES = 32;

// Starting and finishing OAuth are anonymous, so they are limited per address (Stage 1 plan section 9).
export const OAUTH_PER_ADDRESS_PER_MINUTE_MAX = 10;
