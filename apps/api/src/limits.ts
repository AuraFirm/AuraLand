// Process-level limits for the API. Every value has a unit and a reason.

// On SIGTERM we stop accepting work and give in-flight requests this long to finish, which is
// shorter than the 30 s the container orchestrator waits before sending SIGKILL.
export const SHUTDOWN_TIMEOUT_MS_MAX = 10_000;

// Readiness must answer quickly or the load balancer will mark the instance unhealthy anyway.
export const READINESS_CHECK_TIMEOUT_MS_MAX = 2_000;

// A request holds one pooled connection for its transaction and may ask for a second, short one (the rate
// limiter counts in its own committed transaction). If as many requests as there are connections each held
// one and waited for another, none could ever proceed: the pool would be deadlocked for good. So at most half
// the pool may be inside a handler at once (see platform/gate.ts); the others wait their turn in memory.
export const HANDLER_SHARE_OF_POOL = 0.5;

// How many requests may wait for their turn before more are turned away (503 with Retry-After): a queue
// without a bound is the same overload, only slower and with more memory. At the measured rate of this API
// (hundreds of requests a second) two seconds of queue is about this many.
export const REQUESTS_WAITING_MAX = 1_000;
export const BUSY_RETRY_AFTER_S = 2;

// Slowloris defence: a client must finish sending headers and the whole request within these.
export const SERVER_HEADERS_TIMEOUT_MS = 10_000;
export const SERVER_REQUEST_TIMEOUT_MS = 30_000;
// Slightly longer than the 60 s idle timeout of common load balancers, to avoid races on reuse.
export const SERVER_KEEP_ALIVE_TIMEOUT_MS = 65_000;
