import { type Logger, pino } from "pino";

export type { Logger };

// Secrets and credentials must never reach a log line, whatever a handler logs by mistake.
const REDACTED_PATHS = [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    "*.password",
    "*.token",
    "*.secret",
] as const;

export function createLogger(level: "debug" | "info" | "warn" | "error"): Logger {
    return pino({
        level,
        redact: { paths: [...REDACTED_PATHS], censor: "[redacted]" },
        timestamp: pino.stdTimeFunctions.isoTime,
        base: { service: "aura-api" },
    });
}
