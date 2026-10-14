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

// Validation (Stage 4B) runs each wrong solution in a box against every test; twenty keeps one
// validation job to a bounded number of runs while still covering the usual wrong-answer families.
export const BUNDLE_WRONG_SOLUTIONS_MAX = 20;

// Mutants of the reference that one validation compiles and runs (judge/internal/mutate MaxPerSolution
// must stay equal). Each costs up to one time limit, so the cap is what keeps a job to minutes.
export const VALIDATION_MUTANTS_MAX = 40;
export const BUNDLE_TEST_FILE_BYTES_MAX = 64 * 1024 * 1024;

// Decompressed size over compressed size; above this an archive is treated as a bomb.
export const BUNDLE_COMPRESSION_RATIO_MAX = 100;

// The unpacked tar. Highly compressible tests (long runs of zeros) are legitimate, which is why the
// ratio rule below has a floor and this cap exists as well.
export const BUNDLE_UNCOMPRESSED_BYTES_MAX = 256 * 1024 * 1024;

// Below this much output the ratio rule does not apply. 5 MiB is the unpacked size of the largest
// bundle of small files: 5,000 entries of a 512-byte header and at most one 512-byte data block,
// which compress far better than 100:1 because headers are nearly identical. A bomb that stays under
// 5 MiB hurts nobody.
export const BUNDLE_RATIO_FLOOR_BYTES = 5 * 1024 * 1024;

// A canonical tar header holds a name of at most 100 bytes (we use no prefix field), made of short
// segments and few levels; that is far more than any real layout needs.
export const BUNDLE_PATH_BYTES_MAX = 100;
export const BUNDLE_PATH_SEGMENT_BYTES_MAX = 64;
export const BUNDLE_PATH_DEPTH_MAX = 4;

// task.json is a spec: a thousand tests at a few dozen bytes each fit comfortably.
export const SPEC_FILE_BYTES_MAX = 256 * 1024;

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

// ---- submissions and judging (Stage 3) ----

// Source code sent to be judged: large enough for any contest solution, small enough to bound storage
// and the work of every worker that touches it.
export const SUBMISSION_SOURCE_BYTES_MAX = 256 * 1024;
export const SUBMISSIONS_PER_MINUTE_PER_TASK_MAX = 6;
export const SUBMISSION_PAGE_SIZE_DEFAULT = 25;
export const SUBMISSION_PAGE_SIZE_MAX = 100;

// Above this many ready judge jobs new submissions are refused with a retry hint.
export const JUDGE_QUEUE_READY_MAX = 1_000;
// Validation jobs are heavy (dozens of sandbox runs each) and rare; a short queue is a signal to wait.
export const VALIDATE_QUEUE_READY_MAX = 100;

// Judge nodes (Stage 3): how long an enrollment token lives, and how far a signed request's timestamp
// may differ from our clock before it is refused as stale or from the future.
export const NODE_ENROLLMENT_TTL_S = 60 * 60;
export const NODE_SIGNATURE_SKEW_MS = 60_000;

// Leasing: how long a request may wait for work, and how often the server looks while it waits.
export const LEASE_WAIT_MS_MAX = 25_000;
export const LEASE_POLL_MS = 1_000;
// Bundle downloads by a node use a presigned URL this short; the node fetches at once.
export const NODE_BUNDLE_URL_LIFETIME_S = 5 * 60;
export const JOB_ERROR_CHARS_MAX = 2_000;

// Orders and deliveries (Stage 4A). The item cap mirrors the database check; the page cap bounds lists.
export const ORDER_ITEMS_MAX = 100;
export const ORDER_PAGE_SIZE_MAX = 100;
export const ORDER_TITLE_CHARS_MAX = 200;
export const ORDER_TERMS_CHARS_MAX = 4_000;
export const ORDER_INVOICE_CHARS_MAX = 200;
export const ORDER_DELIVERY_DAYS_MAX = 365;
export const DELIVERY_REVOKE_REASON_CHARS_MAX = 500;
// Comments on versions: characters per comment and per-person rate (a conversation, not a firehose).
export const COMMENT_CHARS_MAX = 8_000;
export const COMMENTS_PER_MINUTE_PER_USER_MAX = 20;
export const COMMENTS_PAGE_SIZE_MAX = 200;
// Download links for delivered bundles live this long; the browser fetches at once.
export const DELIVERY_LINK_LIFETIME_S = 5 * 60;
export const DELIVERY_DOWNLOADS_PER_MINUTE_PER_USER_MAX = 30;

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
assert(BUNDLE_BYTES_MAX < BUNDLE_UNCOMPRESSED_BYTES_MAX, "unpacked cap exceeds the packed cap");
assert(BUNDLE_PATH_SEGMENT_BYTES_MAX < BUNDLE_PATH_BYTES_MAX, "a segment fits in a path");

// Human attacks on a task version (Stage 4B): a written method is evidence a reviewer reads, so it is
// bounded; a person attacks a few versions a day, so ten findings a minute is far above honest use.
export const ATTACK_METHOD_CHARS_MAX = 4_000;
export const ATTACKS_PAGE_SIZE_MAX = 200;
export const ATTACKS_PER_MINUTE_PER_USER_MAX = 10;

// ---- contests (Stage 5) ----

// A contest has a handful of problems (the kit's formats use up to a few dozen); labels are one to three
// capital letters or digits, so 26 single letters are never a limit but 36 problems are plenty.
export const CONTEST_PROBLEMS_MAX = 36;
export const CONTEST_TITLE_CHARS_MAX = 120;
// A contest runs from five minutes (a drill) to a week (a long-running challenge).
export const CONTEST_DURATION_S_MIN = 5 * 60;
export const CONTEST_DURATION_S_MAX = 7 * 24 * 3600;
// ICPC penalty per rejected run, in minutes; zero turns penalties off, two hours is far past any use.
export const CONTEST_PENALTY_MINUTES_MAX = 120;
// The least time between two submissions of one person to one problem; zero turns the limit off, ten
// minutes is the longest a rule can ask a contestant to wait.
export const CONTEST_SUBMIT_INTERVAL_S_MAX = 600;
export const CONTEST_SUBMIT_INTERVAL_S_DEFAULT = 10;
// Registration is one request per person per contest; this bounds bursts across contests.
export const CONTEST_REGISTRATIONS_PER_MINUTE_PER_USER_MAX = 20;
// Ratings need a field to be meaningful: below this many participants who submitted, a rated contest
// is not rated (ADR 0031).
export const CONTEST_RATED_PARTICIPANTS_MIN = 20;
// Contests listed on a page.
export const CONTESTS_PAGE_SIZE_MAX = 50;

// The judge queue may hold this many ready jobs before contest submissions are refused. Practice
// submissions are refused at JUDGE_QUEUE_READY_MAX, ten times fewer, so practice is shed first.
export const CONTEST_JUDGE_QUEUE_READY_MAX = 10_000;
// Submissions one person may send to contests per minute, over all problems (the per-problem interval in
// the rules is the finer limit).
export const CONTEST_SUBMISSIONS_PER_MINUTE_PER_USER_MAX = 30;
