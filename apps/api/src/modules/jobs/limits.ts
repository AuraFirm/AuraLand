// Limits for the job queue. Every value has a unit and a reason (docs/stages/stage-3-plan.md §9).

// How long a lease lasts without a heartbeat. Three missed heartbeats (every TTL/3) lose the job.
export const LEASE_TTL_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = LEASE_TTL_MS / 3;

// Waiting for work: a long poll holds the request this long before answering "nothing yet".
export const LONG_POLL_MS = 25_000;

export const ATTEMPTS_DEFAULT = 5;
export const ATTEMPTS_MAX = 20;

// Retry delay doubles from 5 seconds up to 5 minutes, so a broken dependency is not hammered and a
// transient fault clears quickly.
export const BACKOFF_FIRST_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;

// One sweep handles at most this many expired leases, so a long outage cannot make one pass unbounded.
export const SWEEP_BATCH_MAX = 200;

// Load shedding: above this many ready jobs in one queue, new submissions are refused with a retry hint.
export const QUEUE_READY_SHED_AT = 1_000;

// Payload and result size, matching the database constraint.
export const JOB_JSON_BYTES_MAX = 64 * 1024;
