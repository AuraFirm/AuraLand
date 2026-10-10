import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMigratedTestDatabase } from "@aura/db/test-helpers";

// Runs the end-to-end tests against the real thing: a fresh PostgreSQL database, the built API, the
// built web app on one origin, the local Mailpit, and a real Chromium. Everything it starts is
// stopped again, and the throwaway database is dropped, whatever the outcome.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const API_PORT = 3001;
const WEB_PORT = 3000;
const START_ATTEMPTS = 60;
const START_WAIT_MS = 500;
const WEB_STANDALONE = `${ROOT}apps/web/.next/standalone/apps/web`;

function fail(message: string): never {
    process.stderr.write(`e2e: ${message}\n`);
    process.exit(1);
}

function requireEnvironment(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === "") fail(`${name} must be set (see README)`);
    return value;
}

// The servers get a clean environment: the API rejects AURA_ variables it does not know, and the
// test variables of this machine are none of its business.
function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
    const kept: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !key.startsWith("AURA_")) kept[key] = value;
    }
    return { ...kept, ...extra };
}

async function waitFor(url: string, label: string, child: ChildProcess): Promise<void> {
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
        if (child.exitCode !== null)
            fail(`${label} stopped while starting (exit ${child.exitCode})`);
        const ok = await fetch(url).then(
            (response) => response.ok,
            () => false,
        );
        if (ok) return;
        await new Promise((resolve) => setTimeout(resolve, START_WAIT_MS));
    }
    fail(`${label} did not become ready at ${url}`);
}

// Each server runs in its own process group, so stopping it also stops anything it started.
function start(label: string, args: string[], env: Record<string, string>): ChildProcess {
    const child = spawn("node", args, {
        cwd: ROOT,
        env: cleanEnvironment(env),
        stdio: ["ignore", "inherit", "inherit"],
        detached: true,
    });
    child.on("error", (error) => fail(`could not start ${label}: ${error.message}`));
    return child;
}

function stop(child: ChildProcess): void {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
}

function apiEnvironment(
    databaseUrl: string,
    mailpit: string,
    origin: string,
): Record<string, string> {
    return {
        AURA_ENV: "test",
        AURA_ROLE: "http",
        AURA_HTTP_HOST: "127.0.0.1",
        AURA_HTTP_PORT: String(API_PORT),
        AURA_DATABASE_URL: databaseUrl,
        AURA_LOG_LEVEL: "warn",
        AURA_TRUST_EDGE_REQUEST_ID: "true",
        AURA_PUBLIC_ORIGIN: origin,
        AURA_MAIL_DRIVER: "mailpit",
        AURA_MAIL_API_URL: mailpit,
        AURA_MAIL_FROM: "no-reply@auraland.test",
        AURA_LOGIN_TOKEN_SECRET: randomBytes(32).toString("base64"),
    };
}

async function main(): Promise<number> {
    if (!existsSync(`${ROOT}apps/api/dist/main.js`) || !existsSync(`${WEB_STANDALONE}/server.js`)) {
        fail("build first: pnpm run build");
    }
    // The standalone server serves its static files from beside itself, like the container image does.
    cpSync(`${ROOT}apps/web/.next/static`, `${WEB_STANDALONE}/.next/static`, { recursive: true });
    const mailpit = requireEnvironment("AURA_TEST_MAILPIT_URL");
    const database = await createMigratedTestDatabase(2);
    const origin = `http://localhost:${WEB_PORT}`;
    const children: ChildProcess[] = [];
    try {
        const api = start(
            "the API",
            ["apps/api/dist/main.js"],
            apiEnvironment(database.url, mailpit, origin),
        );
        children.push(api);
        const web = start("the web app", [`${WEB_STANDALONE}/server.js`], {
            PORT: String(WEB_PORT),
            HOSTNAME: "127.0.0.1",
            NODE_ENV: "production",
        });
        children.push(web);
        await waitFor(`http://127.0.0.1:${API_PORT}/api/healthz`, "the API", api);
        await waitFor(`${origin}/healthz`, "the web app", web);
        const tests = spawn(
            "pnpm",
            ["--filter", "@aura/e2e", "exec", "playwright", "test", ...process.argv.slice(2)],
            {
                cwd: ROOT,
                env: {
                    ...process.env,
                    AURA_E2E_ORIGIN: origin,
                    AURA_E2E_DATABASE_URL: database.url,
                },
                stdio: "inherit",
            },
        );
        return await new Promise<number>((resolve) =>
            tests.on("exit", (code) => resolve(code ?? 1)),
        );
    } finally {
        for (const child of children) stop(child);
        await database.drop();
    }
}

process.exit(await main());
