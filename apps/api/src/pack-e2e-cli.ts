import { type ChildProcess, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverySchema, downloadSchema } from "@aura/contracts/api/deliveries";
import { withRequestContext } from "@aura/db/context";
import { createMigratedTestDatabase, type TestDatabase } from "@aura/db/test-helpers";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
    BUCKET,
    out,
    PORT,
    ROOT,
    S3,
    S3_KEY,
    S3_SECRET,
    sleep,
    startAgent,
    startService,
    vm,
    waitUntilListening,
} from "./dev-run-support.ts";
import { bundleKey } from "./platform/object-storage.ts";

// Usage: node apps/api/src/pack-e2e-cli.ts   (needs: pnpm build, pnpm build:opener, the local compose
// services and the Colima VM, as docs/runbooks/judge.md section 7 describes.)
//
// The Stage 4C acceptance run, on the real API, worker and agent: a pack of 20 released versions is
// ordered by one customer, and 3 of the same versions by another. A judge node rewrites every bundle with
// that delivery's tag (and re-checks the verdicts), the worker builds both manifests, and the buyers
// download over HTTP with real sessions. The script then checks what the kit asks for: every download is
// logged, the customer's own verification script passes, the two customers' copies of the same task
// differ byte for byte, and every tag is distinct. It is a developer tool for evidence, not part of CI.

const PACK = 20;
const SMALL_PACK = 3;
const READY_WAIT_MS = 2_000;
const READY_ATTEMPTS = 450; // fifteen minutes
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

interface Seeded {
    readonly big: string;
    readonly small: string;
    readonly versions: readonly string[];
    readonly buyers: { readonly big: string; readonly small: string };
    readonly nodeToken: string;
}

const sessionFor = async (database: TestDatabase, userId: string): Promise<string> => {
    const token = randomBytes(32).toString("base64url");
    await database.database
        .sql`insert into sessions (user_id, token_hash, auth_method, privileged, created_at,
        last_seen_at, idle_expires_at, absolute_expires_at)
        values (${userId}, ${createHash("sha256").update(token).digest()}, 'email_code', false, now(), now(),
                now() + interval '7 days', now() + interval '30 days')`;
    return token;
};

async function person(database: TestDatabase, kind: string, admin = false): Promise<string> {
    const [row] = await database.database.sql<
        { id: string }[]
    >`insert into users (email, email_verified_at, platform_role)
        values (${`${kind}-${randomBytes(3).toString("hex")}@example.com`}, now(), ${admin ? "admin" : "none"}) returning id`;
    return row?.id ?? "";
}

// Released versions planted the way the end-to-end tests plant them (a release needs a review stint
// that this run is not about), with the golden bundle in storage under each seller's key.
async function plantVersions(database: TestDatabase, s3: S3Client, bundle: Buffer, admin: string) {
    const { sql } = database.database;
    const sha = createHash("sha256").update(bundle).digest();
    const maker = await person(database, "maker");
    const [seller] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', ${`seller-${randomBytes(3).toString("hex")}`}, 'Seller') returning id`;
    const sellerId = seller?.id ?? "";
    await s3.send(
        new PutObjectCommand({
            Bucket: BUCKET,
            Key: bundleKey(sellerId, sha.toString("hex")),
            Body: bundle,
        }),
    );
    return sql.begin(async (tx) => {
        await tx`alter table task_versions disable trigger task_versions_guard`;
        const ids: string[] = [];
        for (let n = 1; n <= PACK; n++) {
            const [task] = await tx<
                { id: string }[]
            >`insert into tasks (org_id, slug, kind, visibility, title, created_by)
                values (${sellerId}, ${`pack-${n}`}, 'algorithmic', 'private', ${`Sum ${n}`}, ${maker}) returning id`;
            const [version] = await tx<{ id: string }[]>`insert into task_versions
                (org_id, task_id, seq, state, spec, statement, bundle_bytes, bundle_sha256, created_by, released_by, released_at, waived, submitted_at)
                values (${sellerId}, ${task?.id ?? ""}, 1, 'released', ${tx.json(SPEC)}, 'Add the numbers.', ${bundle.length}, ${sha}, ${maker}, ${admin}, now(), true, now())
                returning id`;
            ids.push(version?.id ?? "");
        }
        await tx`alter table task_versions enable trigger task_versions_guard`;
        return ids;
    });
}

async function seed(database: TestDatabase, s3: S3Client, bundle: Buffer): Promise<Seeded> {
    const { sql } = database.database;
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => undefined);
    const admin = await person(database, "admin", true);
    const versions = await plantVersions(database, s3, bundle, admin);
    const buyer = {
        big: await person(database, "buyer-a"),
        small: await person(database, "buyer-b"),
    };
    const order = async (title: string, buyerId: string, count: number): Promise<string> => {
        const [lab] = await sql<
            { id: string }[]
        >`insert into orgs (kind, slug, name) values ('ai_lab', ${`lab-${randomBytes(3).toString("hex")}`}, ${title}) returning id`;
        await sql`insert into memberships (org_id, user_id, role) values (${lab?.id ?? ""}, ${buyerId}, 'buyer')`;
        const now = new Date();
        const rows = await withRequestContext(
            sql,
            { role: "aura_app", actorKind: "user", userId: admin, orgIds: [] },
            async (tx) => {
                const [o] = await tx<
                    { id: string }[]
                >`select create_order(${lab?.id ?? ""}, ${title}, 'Internal evaluation.', 30, ${now}) as id`;
                for (const version of versions.slice(0, count))
                    await tx`select add_order_item(${o?.id ?? ""}, ${version}, ${now})`;
                return tx<
                    { id: string }[]
                >`select place_order(${o?.id ?? ""}, ${randomBytes(16).toString("hex")}, ${now}) as id`;
            },
        );
        return rows[0]?.id ?? "";
    };
    const [big, small] = [
        await order("Pack A", buyer.big, PACK),
        await order("Pack B", buyer.small, SMALL_PACK),
    ];
    const nodeToken = randomBytes(32).toString("base64url");
    await sql`insert into node_enrollments (token_hash, created_by, created_at, expires_at, attestation)
        values (${createHash("sha256").update(nodeToken).digest()}, ${admin}, now(), now() + interval '1 hour', 'development')`;
    return { big, small, versions, buyers: buyer, nodeToken };
}

// A plain HTTP call with a session cookie, in the shape the browser sends (the API demands the custom
// header and a same-origin Origin on writes). Uses node:http so this tool needs no exception for fetch.
function call(
    method: string,
    path: string,
    cookie: string,
    body?: unknown,
): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = request(
            {
                host: "127.0.0.1",
                port: PORT,
                path,
                method,
                headers: {
                    cookie: `aura_session=${cookie}`,
                    "x-aura-request": "1",
                    origin: `http://localhost:${PORT}`,
                    "sec-fetch-site": "same-origin",
                    ...(payload
                        ? { "content-type": "application/json", "content-length": payload.length }
                        : {}),
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () =>
                    resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
                );
            },
        );
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function download(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        request(url, { method: "GET" }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
                res.statusCode === 200
                    ? resolve(Buffer.concat(chunks))
                    : reject(new Error(`storage answered ${res.statusCode}`)),
            );
        })
            .on("error", reject)
            .end();
    });
}

async function waitUntilReady(database: TestDatabase, ids: readonly string[]): Promise<void> {
    for (let i = 0; i < READY_ATTEMPTS; i++) {
        const rows = await database.database.sql<
            { state: string }[]
        >`select state from deliveries where id = any(${[...ids]})`;
        const recorded = await database.database.sql<
            { n: string }[]
        >`select count(*)::text as n from delivery_bundles`;
        if (i % 15 === 0)
            out(
                `  ${recorded[0]?.n} bundles recorded; deliveries ${rows.map((r) => r.state).join(", ")}`,
            );
        if (rows.length === ids.length && rows.every((r) => r.state === "ready")) return;
        await sleep(READY_WAIT_MS);
    }
    throw new Error(
        `the deliveries were not ready in time; agent log:\n${await vm("tail -20 /tmp/e2e-agent.log")}`,
    );
}

interface Fetched {
    readonly manifest: string;
    readonly manifestSha: string;
    readonly files: Map<string, Buffer>;
}

// What the customer does: read the delivery, ask for a link per item, fetch each bundle.
async function fetchAsBuyer(
    deliveryId: string,
    session: string,
    versions: readonly string[],
): Promise<Fetched> {
    const publicId = `dlv_${deliveryId}`;
    const read = await call("GET", `/api/v1/deliveries/${publicId}`, session);
    const body = deliverySchema.parse(JSON.parse(read.body.toString()));
    if (body.manifest === null || body.manifest_sha256 === null)
        throw new Error("the delivery has no manifest");
    const files = new Map<string, Buffer>();
    for (const version of versions) {
        const link = await call("POST", `/api/v1/deliveries/${publicId}/downloads`, session, {
            task_version_id: `tsv_${version}`,
        });
        if (link.status !== 200)
            throw new Error(`no link for ${version}: ${link.status} ${link.body.toString()}`);
        const bytes = await download(downloadSchema.parse(JSON.parse(link.body.toString())).url);
        files.set(createHash("sha256").update(bytes).digest("hex"), bytes);
    }
    return { manifest: body.manifest, manifestSha: body.manifest_sha256, files };
}

function verifyWithCustomerScript(fetched: Fetched, scratch: string, name: string): boolean {
    const dir = join(scratch, name);
    mkdirSync(dir);
    for (const [sha, bytes] of fetched.files) writeFileSync(join(dir, `${sha}.tar.zst`), bytes);
    writeFileSync(join(scratch, `${name}.manifest.json`), fetched.manifest);
    const result = spawnSync(
        process.execPath,
        [
            `${ROOT}tools/verify-delivery-cli.ts`,
            "--manifest",
            join(scratch, `${name}.manifest.json`),
            "--bundles",
            dir,
            "--manifest-sha256",
            fetched.manifestSha,
        ],
        { encoding: "utf8" },
    );
    out(
        `  customer script (${name}): exit ${result.status}: ${result.stdout.trim().split("\n").slice(-1)[0] ?? ""}`,
    );
    return result.status === 0;
}

async function checks(database: TestDatabase, seeded: Seeded, scratch: string): Promise<string[]> {
    const { sql } = database.database;
    const problems: string[] = [];
    const [a, b] = [
        await fetchAsBuyer(
            seeded.big,
            await sessionFor(database, seeded.buyers.big),
            seeded.versions,
        ),
        await fetchAsBuyer(
            seeded.small,
            await sessionFor(database, seeded.buyers.small),
            seeded.versions.slice(0, SMALL_PACK),
        ),
    ];
    if (!verifyWithCustomerScript(a, scratch, "pack-a"))
        problems.push("customer A's verification failed");
    if (!verifyWithCustomerScript(b, scratch, "pack-b"))
        problems.push("customer B's verification failed");
    const shared = [...a.files.keys()].filter((sha) => b.files.has(sha));
    if (shared.length > 0)
        problems.push(`${shared.length} delivered bundle(s) are byte-identical across customers`);
    const [log] = await sql<
        { n: string }[]
    >`select count(*)::text as n from delivery_access where delivery_id = ${seeded.big}`;
    if (Number(log?.n) !== PACK)
        problems.push(`expected ${PACK} logged downloads for pack A, found ${log?.n}`);
    const [tags] = await sql<
        { total: string; distinct: string; marked: string; checked: string }[]
    >`
        select count(*)::text as total, count(distinct tag)::text as distinct,
               count(*) filter (where solutions_marked)::text as marked, count(*) filter (where verdicts_checked)::text as checked
        from delivery_bundles`;
    out(
        `  recorded: ${tags?.total} bundles, ${tags?.distinct} distinct tags, ${tags?.marked} marked, ${tags?.checked} re-checked`,
    );
    const expected = String(PACK + SMALL_PACK);
    if (
        tags?.total !== expected ||
        tags.distinct !== expected ||
        tags.marked !== expected ||
        tags.checked !== expected
    ) {
        problems.push("every bundle should be recorded, distinctly tagged, marked and re-checked");
    }
    return problems;
}

async function main(): Promise<number> {
    const database = await createMigratedTestDatabase(4);
    const s3 = new S3Client({
        region: "us-east-1",
        endpoint: S3,
        forcePathStyle: true,
        credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET },
    });
    const scratch = mkdtempSync(join(tmpdir(), "aura-pack-"));
    const children: ChildProcess[] = [];
    try {
        const seeded = await seed(database, s3, readFileSync(BUNDLE_FILE));
        out(
            `seeded: ${PACK} released versions, pack A (${PACK}) and pack B (${SMALL_PACK}) placed`,
        );
        children.push(startService("http", database.url), startService("worker", database.url));
        await waitUntilListening();
        out(`API and worker up; agent ${await startAgent(seeded.nodeToken, 1500)} started`);
        await waitUntilReady(database, [seeded.big, seeded.small]);
        out("both deliveries ready; the buyers download and verify");
        const problems = await checks(database, seeded, scratch);
        for (const problem of problems) out(`PROBLEM: ${problem}`);
        out(problems.length === 0 ? "ACCEPTED" : "NOT ACCEPTED");
        return problems.length === 0 ? 0 : 1;
    } finally {
        await vm("pkill -f 'aura-judge run' || true");
        for (const child of children) child.kill("SIGTERM");
        rmSync(scratch, { recursive: true, force: true });
        await database.drop();
    }
}

process.exit(await main());
