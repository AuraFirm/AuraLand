import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withRequestContext } from "@aura/db/context";
import { createMigratedTestDatabase, type TestDatabase } from "@aura/db/test-helpers";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { bundleKey } from "./platform/object-storage.ts";

// Usage: node apps/api/src/validate-e2e-cli.ts   (needs: pnpm build, pnpm build:opener, the local
// compose services, and a running Colima VM set up as docs/runbooks/judge.md section 7 describes.)
//
// The one run that joins both halves of validation: the REAL API (built, on this machine, with real
// PostgreSQL and real S3) and the REAL agent (built in the VM, with real isolate, Node, g++ and python3)
// over HTTP. A task version waits in review; a reviewer asks for validation; the agent enrolls,
// becomes active, leases the job, downloads the bundle from storage, opens it in a box, runs every
// solution, mutant and attacker, and reports; the API stores the report. The script then prints what
// the database holds. It is a developer tool for evidence, not part of CI: it needs the VM.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PORT = 3002;
const BUCKET = "aura-e2e";
const S3 = "http://127.0.0.1:8333";
const POLL_MS = 2_000;
const POLL_MAX = 60; // two minutes
const BUNDLE_FILE = `${ROOT}packages/bundle/corpus/golden-solved.tar.zst`;
const SPEC = {
    spec_version: 1,
    kind: "algorithmic",
    title: "Sum of two numbers",
    time_limit_ms: 1000,
    memory_limit_kib: 262144,
    output_limit_kib: 1024,
    languages: ["cpp", "python3"],
    scoring: { type: "binary", subtasks: [] },
    tests: [
        { id: "001", group: "all", points: 50, is_sample: true },
        { id: "002", group: "all", points: 50, is_sample: false },
    ],
    checker: { type: "exact" },
    license: { owner: "Acme", terms: "internal use" },
    provenance: { author: "Alice", created: "2026-10-10", generated_with_ai: false },
};

const out = (text: string) => process.stdout.write(`${text}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function vm(command: string, background = false): Promise<string> {
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

interface Seeded {
    readonly versionId: string;
    readonly token: string;
}

// A version in review with its bundle in storage, a reviewer who asks for validation, and a one-use
// enrollment token for the node. Everything goes through the same tables and functions a real flow uses.
async function seed(database: TestDatabase, s3: S3Client, bundle: Buffer): Promise<Seeded> {
    const { sql } = database.database;
    const bundleSha = createHash("sha256").update(bundle).digest();
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => undefined);
    const slug = randomBytes(3).toString("hex");
    const person = async (kind: string, admin = false) => {
        const [row] = await sql<
            { id: string }[]
        >`insert into users (email, email_verified_at, platform_role)
            values (${`${kind}-${slug}@example.com`}, now(), ${admin ? "admin" : "none"}) returning id`;
        return row?.id ?? "";
    };
    const [admin, setter, reviewer] = [
        await person("admin", true),
        await person("setter"),
        await person("reviewer"),
    ];
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', ${`e2e-${slug}`}, 'E2E') returning id`;
    const orgId = org?.id ?? "";
    await sql`insert into memberships (org_id, user_id, role) values (${orgId}, ${setter}, 'setter'), (${orgId}, ${reviewer}, 'reviewer')`;
    const [task] = await sql<
        { id: string }[]
    >`insert into tasks (org_id, slug, kind, visibility, title, created_by) values (${orgId}, ${`sum-${slug}`}, 'algorithmic', 'private', 'Sum', ${setter}) returning id`;
    await sql`insert into task_assignments (task_id, org_id, user_id, assigned_by, created_at) values (${task?.id ?? ""}, ${orgId}, ${reviewer}, ${admin}, now())`;
    const [version] = await sql<
        { id: string }[]
    >`insert into task_versions (org_id, task_id, seq, created_by) values (${orgId}, ${task?.id ?? ""}, 1, ${setter}) returning id`;
    const versionId = version?.id ?? "";
    await sql`update task_versions set state = 'uploaded', bundle_bytes = ${bundle.length}, bundle_sha256 = ${bundleSha} where id = ${versionId}`;
    await sql`update task_versions set spec = ${sql.json(SPEC)}, statement = 'Add the numbers.' where id = ${versionId}`;
    await sql`update task_versions set state = 'in_review' where id = ${versionId}`;
    await s3.send(
        new PutObjectCommand({
            Bucket: BUCKET,
            Key: bundleKey(orgId, bundleSha.toString("hex")),
            Body: bundle,
        }),
    );
    const token = randomBytes(32).toString("base64url");
    await sql`insert into node_enrollments (token_hash, created_by, created_at, expires_at, attestation)
        values (${createHash("sha256").update(token).digest()}, ${admin}, now(), now() + interval '1 hour', 'development')`;
    await withRequestContext(
        sql,
        { role: "aura_app", actorKind: "user", userId: reviewer, orgIds: [] },
        (tx) => tx`select request_validation(${versionId}, now(), 100)`,
    );
    return { versionId, token };
}

function startApi(databaseUrl: string): ChildProcess {
    return spawn("node", ["apps/api/dist/main.js"], {
        cwd: ROOT,
        stdio: ["ignore", "inherit", "inherit"],
        env: {
            PATH: process.env["PATH"] ?? "",
            AURA_ENV: "test",
            AURA_ROLE: "http",
            AURA_HTTP_HOST: "0.0.0.0", // the VM reaches this machine as host.lima.internal
            AURA_HTTP_PORT: String(PORT),
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
            AURA_S3_ACCESS_KEY_ID: "aura-dev-access-key",
            AURA_S3_SECRET_ACCESS_KEY: "aura-dev-secret-key-local-only",
        },
    });
}

async function waitUntilHealthy(): Promise<void> {
    for (let i = 0; i < 60; i++) {
        const healthy = await fetch(`http://127.0.0.1:${PORT}/api/healthz`).then(
            (r) => r.ok,
            () => false,
        );
        if (healthy) return;
        await sleep(500);
    }
    throw new Error("the API did not become healthy");
}

// Builds the agent in the VM, enrolls it with the seeded token and starts it in the background.
async function startAgent(token: string): Promise<string> {
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
        `timeout 150 /tmp/aura-judge run --control-plane ${plane} --node-id ${nodeId} --key-file /tmp/e2e.key --opener-file ${repo}/packages/bundle/dist/open-bundle.cjs > /tmp/e2e-agent.log 2>&1`,
        true,
    );
    return nodeId;
}

interface Report {
    attestation: string;
    passed: boolean;
    score: string | null;
    checks: { name: string; ok: boolean; detail: string }[];
}

async function waitForReport(database: TestDatabase, versionId: string): Promise<Report> {
    for (let i = 0; i < POLL_MAX; i++) {
        await sleep(POLL_MS);
        const [report] = await database.database.sql<
            Report[]
        >`select attestation, passed, score::text, checks
            from validation_reports where task_version_id = ${versionId}`;
        if (report !== undefined) return report;
    }
    throw new Error(
        `no report arrived within two minutes; agent log:\n${await vm("tail -20 /tmp/e2e-agent.log")}`,
    );
}

async function main(): Promise<number> {
    const database = await createMigratedTestDatabase(3);
    const s3 = new S3Client({
        region: "us-east-1",
        endpoint: S3,
        forcePathStyle: true,
        credentials: {
            accessKeyId: "aura-dev-access-key",
            secretAccessKey: "aura-dev-secret-key-local-only",
        },
    });
    let api: ChildProcess | null = null;
    try {
        const { versionId, token } = await seed(database, s3, readFileSync(BUNDLE_FILE));
        out("seeded: a version in review, validation requested, bundle in storage");
        api = startApi(database.url);
        await waitUntilHealthy();
        out(`the API is up; enrolled ${await startAgent(token)}`);
        const report = await waitForReport(database, versionId);
        const [after] = await database.database.sql<
            { state: string }[]
        >`select state from task_versions where id = ${versionId}`;
        out(
            `REPORT attestation=${report.attestation} passed=${report.passed} score=${report.score} version_state=${after?.state}`,
        );
        for (const check of report.checks)
            out(
                `  ${check.ok ? "ok  " : "FAIL"} ${check.name}${check.detail === "" ? "" : ` (${check.detail})`}`,
            );
        // The bundle is deliberately imperfect (one wrong solution does not compile, and the task is a
        // plain sum a generic program solves), so the expected outcome is a report that did not pass.
        const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
        const expected = [
            "wrong_fails:wrong_noncompiling.cpp",
            "attacker_rejected:sum_of_integers",
        ];
        return report.attestation === "development" &&
            JSON.stringify(failed) === JSON.stringify(expected)
            ? 0
            : 1;
    } finally {
        await vm("pkill -f 'aura-judge run' || true");
        api?.kill("SIGTERM");
        await database.drop();
    }
}

process.exit(await main());
