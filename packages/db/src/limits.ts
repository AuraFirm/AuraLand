// Pool and context limits. Each has a reason so a reviewer can judge a change to it.

// One API instance should not hold more than this many connections: RDS connection slots are
// shared by every instance, worker and migration job.
export const POOL_CONNECTIONS_MAX = 10;

// Idle connections are closed after this long so a quiet instance gives slots back.
export const POOL_IDLE_TIMEOUT_S = 30;

// A connection attempt that takes longer than this is a network fault, not a slow query.
export const POOL_CONNECT_TIMEOUT_S = 5;

// Recycling connections bounds the damage of any per-connection state leak or memory growth.
export const POOL_MAX_LIFETIME_S = 30 * 60;

// A request may act for at most this many organizations. Bounds the size of the RLS setting.
export const CONTEXT_ORGS_MAX = 64;
