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
