// Goal: the Go agent and this control plane agree in practice, not only on fixtures. A real HTTP server
// runs the real app; the Go agent (built from judge/, driven by `go test -tags integration`) enrolls
// with a token an administrator created, becomes active, leases a participant's submission, judges it
// with a fake sandbox (no code runs) and reports; this test then checks the verdict in the database.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { submissionSchema } from "@aura/contracts/api/submissions";
import { versionSchema } from "@aura/contracts/api/task-versions";
import { encodeId } from "@aura/contracts/ids";
import { enrollmentCreatedSchema } from "@aura/contracts/judge-protocol";
import { getRequestListener } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import { taskWorld } from "./http-task-support.ts";

const CAROL = "018f0000-0000-7000-8000-0000000000c3";
const DAVE = "018f0000-0000-7000-8000-0000000000d4";
const JUDGE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../../../judge");

let h: Harness;
beforeAll(async () => {
    h = await createHarness();
});
afterAll(async () => {
    await h.drop();
});

const CAROL_ID = CAROL;

// The Go toolchain needs the developer's own environment (PATH, caches).
const toolchainEnvironment = process.env; // tigerlint-allow: env-only-in-config -- passed to the Go toolchain

// A released task in a team, and one queued submission by a plain member.
async function queuedSubmission() {
    const { sql } = h.db.database;
    await sql`update users set platform_role = 'admin' where id = ${ALICE}`;
    for (const [id, name] of [
        [CAROL_ID, "carol"],
        [DAVE, "dave"],
    ] as const) {
        await sql`insert into users (id, email, email_verified_at) values (${id}, ${`${name}@example.com`}, now())`;
    }
    const [org] = await sql<
        { id: string }[]
    >`insert into orgs (kind, slug, name) values ('company', 'agent-team', 'Agent Team') returning id`;
    await sql`insert into memberships (org_id, user_id, role) values
        (${org?.id ?? ""}, ${ALICE}, 'owner'), (${org?.id ?? ""}, ${BOB}, 'setter'),
        (${org?.id ?? ""}, ${CAROL_ID}, 'reviewer'), (${org?.id ?? ""}, ${DAVE}, 'member')`;
    const world = taskWorld(h, encodeId("org", org?.id ?? ""));
    const version = await world.inReview(BOB, await world.newTask(BOB, "org"));
    await world.call(CAROL_ID, "POST", `/task-versions/${version.id}/review`, {
        outcome: "approved",
    });
    const release = await world.call(CAROL_ID, "POST", `/task-versions/${version.id}/release`, {
        waiver_reason: "Checked by hand; no sandbox yet.",
    });
    const released = versionSchema.parse(await release.json());
    const submit = await world.call(DAVE, "POST", `/task-versions/${released.id}/submissions`, {
        language: "cpp",
        source: "int main() {}",
    });
    return submissionSchema.parse(await submit.json());
}

async function enrollmentToken(): Promise<string> {
    const admin = await h.login(ALICE);
    const created = await h.request("/admin/judge-nodes/enrollments", {
        method: "POST",
        headers: browser(admin.token),
    });
    return enrollmentCreatedSchema.parse(await created.json()).token;
}

// Runs the agent's Go integration test against a real HTTP server on the app, and waits for it.
async function runGoAgent(token: string): Promise<{ status: number | null; output: string }> {
    const server = createServer(getRequestListener(h.app().fetch));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    try {
        return await new Promise((resolve) => {
            const child = spawn(
                "go",
                [
                    "test",
                    "-tags",
                    "integration",
                    "-count=1",
                    "-v",
                    "-run",
                    "TestAgainstTheRealControlPlane",
                    "./internal/agent",
                ],
                {
                    cwd: JUDGE_DIRECTORY,
                    env: {
                        ...toolchainEnvironment,
                        AURA_JUDGE_URL: `http://127.0.0.1:${address.port}/api/judge/v1`,
                        AURA_JUDGE_ENROLL_TOKEN: token,
                        AURA_JUDGE_NOW_MS: String(h.clock.nowUnixMs()),
                    },
                },
            );
            let output = "";
            child.stdout.on("data", (d: Buffer) => (output += d.toString()));
            child.stderr.on("data", (d: Buffer) => (output += d.toString()));
            child.on("exit", (status) => resolve({ status, output }));
        });
    } finally {
        server.close();
    }
}

describe("the Go agent against the real control plane", () => {
    it("enrolls, activates, leases a submission, judges it and reports; the verdict lands in the database", async () => {
        const made = await queuedSubmission();
        const run = await runGoAgent(await enrollmentToken());
        expect(run.output).toContain("--- PASS: TestAgainstTheRealControlPlane");
        expect(run.status).toBe(0);
        const { sql } = h.db.database;
        const judged =
            await sql`select state, verdict, score from submissions where id = ${made.id.slice(4)}`;
        expect([
            judged[0]?.["state"],
            judged[0]?.["verdict"],
            Number(judged[0]?.["score"]),
        ]).toEqual(["judged", "AC", 100]);
        const details =
            await sql`select test_id, verdict from verdict_details where submission_id = ${made.id.slice(4)}`;
        expect(details.map((d) => `${d["test_id"]}:${d["verdict"]}`)).toEqual(["001:AC"]);
    }, 180_000);
});
