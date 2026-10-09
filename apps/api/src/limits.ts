// Process-level limits for the API. Every value has a unit and a reason.

// On SIGTERM we stop accepting work and give in-flight requests this long to finish, which is
// shorter than the 30 s the container orchestrator waits before sending SIGKILL.
export const SHUTDOWN_TIMEOUT_MS_MAX = 10_000;

// Readiness must answer quickly or the load balancer will mark the instance unhealthy anyway.
export const READINESS_CHECK_TIMEOUT_MS_MAX = 2_000;

// Slowloris defence: a client must finish sending headers and the whole request within these.
export const SERVER_HEADERS_TIMEOUT_MS = 10_000;
export const SERVER_REQUEST_TIMEOUT_MS = 30_000;
// Slightly longer than the 60 s idle timeout of common load balancers, to avoid races on reuse.
export const SERVER_KEEP_ALIVE_TIMEOUT_MS = 65_000;
