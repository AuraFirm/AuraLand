import { type DestinationStream, type Logger, pino } from "pino";

export type { Logger };

// Secrets and credentials must never reach a log line, whatever a handler logs by mistake.
const REDACTED_PATHS = [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    "*.password",
    "*.token",
    "*.secret",
    "*.code",
    "*.otp",
    "*.key",
    "*.binding",
    "*.email",
] as const;

// `destination` is for tests; in production lines go to standard output.
export function createLogger(
    level: "debug" | "info" | "warn" | "error",
    destination?: DestinationStream,
): Logger {
    const options = {
        level,
        redact: { paths: [...REDACTED_PATHS], censor: "[redacted]" },
        timestamp: pino.stdTimeFunctions.isoTime,
        base: { service: "aura-api" },
    };
    return destination === undefined ? pino(options) : pino(options, destination);
}
