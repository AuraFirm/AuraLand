import { createServer } from "node:http";
import { createDatabase } from "@aura/db/client";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfigFromProcess } from "./config.ts";
import {
    SERVER_HEADERS_TIMEOUT_MS,
    SERVER_KEEP_ALIVE_TIMEOUT_MS,
    SERVER_REQUEST_TIMEOUT_MS,
    SHUTDOWN_TIMEOUT_MS_MAX,
} from "./limits.ts";
import { systemClock } from "./platform/clock.ts";
import { createLogger } from "./platform/log.ts";

// Process entry point: wire real dependencies, serve, and stop cleanly on signals or invariant
// violations. This is the only place that terminates the process.

const config = loadConfigFromProcess();
const logger = createLogger(config.AURA_LOG_LEVEL);
const database = createDatabase(config.AURA_DATABASE_URL);

let stopping = false;
async function stop(reason: string, exitCode: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.warn({ reason, exit_code: exitCode }, "stopping");
    // If graceful shutdown stalls, exit anyway rather than hang until the orchestrator kills us.
    setTimeout(() => process.exit(exitCode || 1), SHUTDOWN_TIMEOUT_MS_MAX).unref();
    server.close();
    server.closeIdleConnections();
    await database.close(5);
    process.exit(exitCode);
}

const app = createApp({
    config,
    logger,
    clock: systemClock,
    pingDatabase: async () => {
        await database.sql`select 1`;
    },
    onInvariantViolation: () => void stop("invariant violation", 1),
});

// Plain HTTP/1.1 behind the load balancer; the explicit server gives typed access to timeouts.
const server = createServer(getRequestListener(app.fetch));
server.listen(config.AURA_HTTP_PORT, config.AURA_HTTP_HOST);
server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
logger.info({ port: config.AURA_HTTP_PORT, env: config.AURA_ENV }, "listening");

process.on("SIGTERM", () => void stop("SIGTERM", 0));
process.on("SIGINT", () => void stop("SIGINT", 0));
// Reaching these handlers means a bug escaped every other net, so we log and stop.
process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "uncaught exception");
    void stop("uncaught exception", 1);
});
process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled rejection");
    void stop("unhandled rejection", 1);
});
