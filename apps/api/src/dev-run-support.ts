import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

// Shared by the developer tools that join the real API and the real agent (validate-e2e-cli.ts,
// pack-e2e-cli.ts). They are for evidence on a development machine with the local services and the Colima
// VM, not part of CI.

export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const PORT = 3002;
export const BUCKET = "aura-e2e";
export const S3 = "http://127.0.0.1:8333";
export const S3_KEY = "aura-dev-access-key";
export const S3_SECRET = "aura-dev-secret-key-local-only";

export const out = (text: string) => process.stdout.write(`${text}\n`);
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A command in the VM. With `background` it returns at once and the command keeps running there.
export function vm(command: string, background = false): Promise<string> {
    return new Promise((resolve) => {
        const child = spawn("colima", ["ssh", "--", "sh", "-c", command], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        child.stdout.on("data", (chunk) => {
            text += chunk;
        });
        child.stderr.on("data", (chunk) => {
            text += chunk;
        });
        child.on("exit", () => resolve(text));
        if (background) resolve("started");
    });
}

// The built service in a role. The HTTP role listens on every interface because the VM reaches this
// machine as host.lima.internal.
export function startService(role: "http" | "worker", databaseUrl: string): ChildProcess {
    return spawn(process.execPath, ["apps/api/dist/main.js"], {
        cwd: ROOT,
        stdio: ["ignore", "inherit", "inherit"],
        env: {
            AURA_ENV: "test",
            AURA_ROLE: role,
            AURA_HTTP_HOST: "0.0.0.0",
            AURA_HTTP_PORT: String(role === "http" ? PORT : PORT + 1),
            AURA_DATABASE_URL: databaseUrl,
            AURA_LOG_LEVEL: "warn",
            AURA_TRUST_EDGE_REQUEST_ID: "true",
            AURA_PUBLIC_ORIGIN: `http://localhost:${PORT}`,
            AURA_MAIL_DRIVER: "disabled",
            AURA_MAIL_FROM: "no-reply@auraland.test",
            AURA_LOGIN_TOKEN_SECRET: randomBytes(32).toString("base64"),
            AURA_STORAGE_DRIVER: "s3",
            AURA_S3_ENDPOINT: S3,
            AURA_S3_PUBLIC_ENDPOINT: S3,
            AURA_S3_BUCKET: BUCKET,
            AURA_S3_REGION: "us-east-1",
            AURA_S3_ACCESS_KEY_ID: S3_KEY,
            AURA_S3_SECRET_ACCESS_KEY: S3_SECRET,
        },
    });
}

// Ready when the port accepts a connection. A plain TCP check: this tool makes no HTTP request of its
// own here, so it needs no exception to the rule that outbound HTTP goes through the egress client.
function accepts(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });
}

export async function waitUntilListening(port = PORT): Promise<void> {
    for (let i = 0; i < 60; i++) {
        if (await accepts(port)) return;
        await sleep(500);
    }
    throw new Error(`nothing started listening on port ${port}`);
}

// Builds the agent in the VM, enrolls it with the token and starts it in the background with the programs
// it needs. `seconds` bounds how long the agent runs, so a forgotten one cannot linger.
export async function startAgent(token: string, seconds: number): Promise<string> {
    const repo = ROOT.replace(/\/$/, "");
    const build = await vm(
        `cd ${repo}/judge && export PATH=$PATH:/usr/local/go/bin && go build -o /tmp/aura-judge ./cmd/aura-judge && echo built`,
    );
    if (!build.includes("built")) throw new Error(`agent build failed: ${build}`);
    const plane = `http://host.lima.internal:${PORT}/api/judge/v1`;
    const enrolled = await vm(
        `rm -f /tmp/e2e.key && /tmp/aura-judge enroll --control-plane ${plane} --token ${token} --name e2e-node --key-file /tmp/e2e.key`,
    );
    const nodeId = /enrolled as (nod_[0-9a-f-]+)/.exec(enrolled)?.[1];
    if (nodeId === undefined) throw new Error(`enrollment failed: ${enrolled}`);
    void vm(
        `timeout ${seconds} /tmp/aura-judge run --control-plane ${plane} --node-id ${nodeId} --key-file /tmp/e2e.key --opener-file ${repo}/packages/bundle/dist/open-bundle.cjs --rewriter-file ${repo}/packages/bundle/dist/rewrite-bundle.cjs > /tmp/e2e-agent.log 2>&1`,
        true,
    );
    return nodeId;
}
