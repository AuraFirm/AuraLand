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

// ---- tasks and bundles (Stage 2) ----

// With no worker yet, the API hashes an upload while streaming it from storage inside one request.
// 64 MiB takes well under a second; the kit's 512 MiB waits for the worker (cutlist).
export const BUNDLE_BYTES_MAX = 64 * 1024 * 1024;

// Matches docs/kit/07 section 7: more entries than this is a bomb or a mistake, not a task.
export const BUNDLE_ENTRIES_MAX = 5_000;
export const BUNDLE_TEST_FILE_BYTES_MAX = 64 * 1024 * 1024;

// Decompressed size over compressed size; above this an archive is treated as a bomb.
export const BUNDLE_COMPRESSION_RATIO_MAX = 100;

// A statement is read by people in one sitting; 64 KiB also bounds rendering work per request.
export const STATEMENT_BYTES_MAX = 64 * 1024;

export const TASK_TITLE_LENGTH_MAX = 120;
export const TASK_SLUG_LENGTH_MIN = 3;
export const TASK_SLUG_LENGTH_MAX = 40;

// Counts that keep one organization from filling the tables.
export const TASKS_PER_ORG_MAX = 1_000;
export const VERSIONS_PER_TASK_MAX = 100;

// S3 allows 10,000 parts of at least 5 MiB; 100 parts of at least 8 MiB covers the cap with room.
export const UPLOAD_PARTS_MAX = 100;
export const UPLOAD_PART_BYTES_MIN = 8 * 1024 * 1024;
export const UPLOAD_PLAN_LIFETIME_S = 60 * 60;
export const UPLOAD_PART_URL_LIFETIME_S = 15 * 60;
export const UPLOADS_UNFINISHED_PER_PERSON_MAX = 5;

// What the judge will accept, in the spec; the sandbox enforces them in Stage 3.
export const TIME_LIMIT_MS_MIN = 100;
export const TIME_LIMIT_MS_MAX = 10_000;
export const MEMORY_LIMIT_KIB_MIN = 16 * 1024;
export const MEMORY_LIMIT_KIB_MAX = 1024 * 1024;
export const OUTPUT_LIMIT_KIB_MAX = 64 * 1024;
export const SPEC_TESTS_MAX = 1_000;
export const SPEC_LANGUAGES_MAX = 20;
export const SPEC_SUBTASKS_MAX = 100;

export const TASK_PAGE_SIZE_DEFAULT = 25;
export const TASK_PAGE_SIZE_MAX = 100;

// Relationships between limits are checked when the module loads, so a bad edit fails at startup.
assert(HANDLE_LENGTH_MIN >= 1 && HANDLE_LENGTH_MIN < HANDLE_LENGTH_MAX, "handle length bounds");
assert(ORG_SLUG_LENGTH_MIN >= 3 && ORG_SLUG_LENGTH_MIN < ORG_SLUG_LENGTH_MAX, "slug length bounds");
assert(
    DISPLAY_NAME_LENGTH_MAX < ORG_NAME_LENGTH_MAX,
    "organization names may be longer than person names",
);
assert(BUNDLE_BYTES_MAX >= UPLOAD_PART_BYTES_MIN, "a bundle fits in at least one part");
assert(
    BUNDLE_BYTES_MAX <= UPLOAD_PARTS_MAX * UPLOAD_PART_BYTES_MIN,
    "the part count can cover the bundle cap",
);
assert(UPLOAD_PART_URL_LIFETIME_S < UPLOAD_PLAN_LIFETIME_S, "part URLs expire before the plan");
assert(TASK_PAGE_SIZE_DEFAULT <= TASK_PAGE_SIZE_MAX, "default page size within the maximum");
assert(TASK_SLUG_LENGTH_MIN < TASK_SLUG_LENGTH_MAX, "task slug bounds");
