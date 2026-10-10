import { defineConfig } from "@playwright/test";

// The runner (src/run-cli.ts) starts the servers and database; this file only says how to test.
export default defineConfig({
    testDir: "src/tests",
    // The tests share one database and one rate-limit bucket, so they run one at a time.
    workers: 1,
    fullyParallel: false,
    retries: 0,
    timeout: 30_000,
    reporter: [["list"]],
    use: {
        baseURL: "http://localhost:3000",
        trace: "retain-on-failure",
    },
    projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
