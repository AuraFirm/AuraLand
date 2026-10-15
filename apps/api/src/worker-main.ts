import { createDatabase } from "@aura/db/client";
import { withRequestContext } from "@aura/db/context";
import { loadConfigFromProcess } from "./config.ts";
import { SHUTDOWN_TIMEOUT_MS_MAX } from "./limits.ts";
import { createFakePaymentProvider } from "./modules/billing/provider.ts";
import { createPgJobStore } from "./modules/jobs/queries.ts";
import { systemClock } from "./platform/clock.ts";
import { createLogger } from "./platform/log.ts";
import { systemRng } from "./platform/rng.ts";
import { createDevelopmentSigner } from "./platform/signer.ts";
import { createStorageFromConfig } from "./platform/storage.ts";
import { maintenanceHandlers, startWorker } from "./worker.ts";

// Worker process: wire real dependencies, run the job loop, stop cleanly on signals.
const config = loadConfigFromProcess();
const logger = createLogger(config.AURA_LOG_LEVEL);
const database = createDatabase(config.AURA_DATABASE_URL);
const WORKER = { role: "aura_worker", actorKind: "worker", userId: null, orgIds: [] } as const;
const inTransaction = <T>(work: Parameters<typeof withRequestContext<T>>[2]) =>
    withRequestContext(database.sql, WORKER, work);

// Credentials are signed in development and test by a key held in memory. There is no production signer yet (a KMS
// adapter waits for an account to run it against, F62), so elsewhere nothing is issued or published.
const developmentEnvironment = config.AURA_ENV === "local" || config.AURA_ENV === "test";
const passport = developmentEnvironment
    ? {
          signer: createDevelopmentSigner({
              keyId: `dev-${Buffer.from(systemRng.nextBytes(4)).toString("hex")}`,
              appEnvironment: config.AURA_ENV,
          }),
          publicOrigin: config.AURA_PUBLIC_ORIGIN,
      }
    : undefined;
if (passport === undefined) logger.warn({}, "passport is off: there is no production signer (F62)");

// Only the fake exists (local development and tests); with no provider configured nothing is reconciled.
const billing =
    config.AURA_BILLING_DRIVER === "fake" ? { provider: createFakePaymentProvider() } : undefined;

const worker = startWorker({
    ...(passport === undefined ? {} : { passport }),
    ...(billing === undefined ? {} : { billing }),
    clock: systemClock,
    rng: systemRng,
    logger,
    context: {
        clock: systemClock,
        storage: createStorageFromConfig(config, systemClock),
        inTransaction,
    },
    withStore: (work) => inTransaction((tx) => work(createPgJobStore(tx))),
    handlers: maintenanceHandlers(),
    queue: "default",
    name: `worker-${process.pid}`,
});
logger.info({ env: config.AURA_ENV }, "worker started");

let stopping = false;
async function stop(reason: string, exitCode: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.warn({ reason, exit_code: exitCode }, "worker stopping");
    setTimeout(() => process.exit(exitCode || 1), SHUTDOWN_TIMEOUT_MS_MAX).unref();
    await worker.stop();
    await database.close(5);
    process.exit(exitCode);
}
process.on("SIGTERM", () => void stop("SIGTERM", 0));
process.on("SIGINT", () => void stop("SIGINT", 0));
process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "uncaught exception");
    void stop("uncaught exception", 1);
});
process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled rejection");
    void stop("unhandled rejection", 1);
});
