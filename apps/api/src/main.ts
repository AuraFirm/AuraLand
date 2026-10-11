import { loadConfigFromProcess } from "./config.ts";

// Process entry point. One image, one bundle, two roles chosen by configuration: the HTTP API serves
// requests; the worker runs jobs from the queue. Each role file owns its own startup and shutdown.
const config = loadConfigFromProcess();
if (config.AURA_ROLE === "worker") {
    await import("./worker-main.ts");
} else {
    await import("./http-main.ts");
}
