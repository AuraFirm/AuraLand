// Goal: judge nodes enroll with a single-use token that only a platform administrator can create, and
// then every request they make must be signed, fresh and unrepeatable. All authentication failures look
// the same from outside. The signature scheme matches the fixture the Go agent verifies.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { problemSchema } from "@aura/contracts/errors";
import { decodeId } from "@aura/contracts/ids";
import {
    enrollmentCreatedSchema,
    enrollResponseSchema,
    nodeHeartbeatResponseSchema,
} from "@aura/contracts/judge-protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, browser, createHarness, type Harness } from "./http-harness.ts";
import {
    newKey,
    SIGNATURE_FIXTURE_PATH,
    signatureFixture,
    signedRequest,
    type TestKey,
} from "./http-judge-support.ts";

let h: Harness;
beforeAll(async () => {
    h = await createHarness();
    await h.db.database.sql`update users set platform_role = 'admin' where id = ${ALICE}`;
});
afterAll(async () => {
    await h.drop();
});

const JUDGE = "/api/judge/v1";
const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = { "content-type": "application/json" },
) => h.app().request(`${JUDGE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

async function newEnrollmentToken(attestation?: string): Promise<string> {
    const { token } = await h.login(ALICE);
    const response = await h.request("/admin/judge-nodes/enrollments", {
        method: "POST",
        headers:
            attestation === undefined
                ? browser(token)
                : { ...browser(token), "content-type": "application/json" },
        ...(attestation === undefined ? {} : { body: JSON.stringify({ attestation }) }),
    });
    expect(response.status).toBe(201);
    return enrollmentCreatedSchema.parse(await response.json()).token;
}

let counter = 0;
async function enrolled(
    attestation?: string,
): Promise<{ nodeId: string; key: TestKey; name: string }> {
    // Enrollment is limited per address and minute; moving on keeps one test from starving the next.
    h.clock.advance(61_000);
    const key = newKey();
    const name = `node-${++counter}`;
    const response = await post("/enroll", {
        token: await newEnrollmentToken(attestation),
        name,
        public_key: key.publicKey.toString("base64url"),
        agent_version: "0.1.0",
        tiers: [1],
    });
    expect(response.status).toBe(201);
    return { nodeId: enrollResponseSchema.parse(await response.json()).node_id, key, name };
}

const heartbeat = (
    node: { nodeId: string; key: TestKey },
    overrides: Record<string, unknown> = {},
    signOptions = {},
) => {
    const body = { agent_version: "0.1.0", canary_ok: true, running_jobs: 0, ...overrides };
    const signed = signedRequest("POST", `${JUDGE}/node/heartbeat`, body, {
        ...node,
        nowMs: h.clock.nowUnixMs(),
        ...signOptions,
    });
    return h.app().request(`${JUDGE}/node/heartbeat`, {
        method: "POST",
        headers: signed.headers,
        body: signed.body,
    });
};

describe("enrollment tokens", () => {
    it("are created by platform administrators only, with a fresh passkey check", async () => {
        const anonymous = await h.request("/admin/judge-nodes/enrollments", {
            method: "POST",
            headers: browser(null),
        });
        expect(anonymous.status).toBe(401);
        const { token } = await h.login(BOB);
        const ordinary = await h.request("/admin/judge-nodes/enrollments", {
            method: "POST",
            headers: browser(token),
        });
        expect(ordinary.status).toBe(404);
        const admin = await h.login(ALICE);
        h.clock.advance(16 * 60 * 1000);
        const stale = await h.request("/admin/judge-nodes/enrollments", {
            method: "POST",
            headers: browser(admin.token),
        });
        expect(stale.status).toBe(403);
    });

    it("are stored only as a hash and shown once", async () => {
        const token = await newEnrollmentToken();
        const rows = await h.db.database.sql<
            { token_hash: Buffer }[]
        >`select token_hash from node_enrollments`;
        const hashes = rows.map((r) => r.token_hash.toString("hex"));
        expect(hashes).toContain(createHash("sha256").update(token).digest("hex"));
        expect(JSON.stringify(rows)).not.toContain(token);
    });
});

describe("enrolling", () => {
    it("spends the token once, and a spent, wrong or expired token gets one answer", async () => {
        const token = await newEnrollmentToken();
        const body = (name: string) => ({
            token,
            name,
            public_key: newKey().publicKey.toString("base64url"),
            agent_version: "0.1.0",
            tiers: [1],
        });
        expect((await post("/enroll", body("first-node"))).status).toBe(201);
        expect((await post("/enroll", body("second-node"))).status).toBe(401);
        const wrong = await post("/enroll", { ...body("third-node"), token: "A".repeat(43) });
        expect(wrong.status).toBe(401);
        const old = await newEnrollmentToken();
        h.clock.advance(61 * 60 * 1000);
        expect((await post("/enroll", { ...body("late-node"), token: old })).status).toBe(401);
    });

    it("refuses duplicates and malformed requests", async () => {
        const first = await enrolled();
        const token = await newEnrollmentToken();
        const key = newKey().publicKey.toString("base64url");
        expect(
            (
                await post("/enroll", {
                    token,
                    name: first.name,
                    public_key: key,
                    agent_version: "0.1.0",
                    tiers: [1],
                })
            ).status,
        ).toBe(409);
        for (const bad of [
            {},
            { token, name: "Bad Name", public_key: key, agent_version: "0.1.0", tiers: [1] },
            { token, name: "ok-name", public_key: "short", agent_version: "0.1.0", tiers: [1] },
            { token, name: "ok-name", public_key: key, agent_version: "0.1.0", tiers: [3] },
            {
                token,
                name: "ok-name",
                public_key: key,
                agent_version: "0.1.0",
                tiers: [1],
                extra: 1,
            },
        ]) {
            expect((await post("/enroll", bad)).status).toBe(400);
        }
    });

    it("limits attempts per address", async () => {
        const codes: number[] = [];
        for (let n = 0; n < 12; n++)
            codes.push(
                (
                    await post("/enroll", {
                        token: "A".repeat(43),
                        name: "probe-node",
                        public_key: newKey().publicKey.toString("base64url"),
                        agent_version: "0.1.0",
                        tiers: [1],
                    })
                ).status,
            );
        expect(codes).toContain(429);
    });
});

describe("heartbeats", () => {
    it("activate a node after a passing self-test and drain it after a failing one", async () => {
        const node = await enrolled();
        const first = nodeHeartbeatResponseSchema.parse(
            await (await heartbeat(node, { canary_ok: false })).json(),
        );
        expect(first.state).toBe("enrolled");
        const second = nodeHeartbeatResponseSchema.parse(await (await heartbeat(node)).json());
        expect(second.state).toBe("active");
        const third = nodeHeartbeatResponseSchema.parse(
            await (await heartbeat(node, { canary_ok: false })).json(),
        );
        expect(third.state).toBe("draining");
    });

    it("refuse malformed bodies", async () => {
        const node = await enrolled();
        expect((await heartbeat(node, { running_jobs: -1 })).status).toBe(400);
        expect((await heartbeat(node, { extra: true })).status).toBe(400);
    });
});

// Eight ways to send a heartbeat that must not be accepted, each with a label.
async function unacceptableHeartbeats(node: {
    nodeId: string;
    key: TestKey;
}): Promise<Array<[string, Response]>> {
    const target = `${JUDGE}/node/heartbeat`;
    const body = { agent_version: "0.1.0", canary_ok: true, running_jobs: 0 };
    const nowMs = h.clock.nowUnixMs();
    const sign = (change: Record<string, unknown> = {}) =>
        signedRequest("POST", target, body, { ...node, nowMs, ...change });
    const good = sign();
    const send = (headers: Record<string, string>, text: string, path = target) =>
        h.app().request(path, { method: "POST", headers, body: text });
    return [
        ["no headers", await send({ "content-type": "application/json" }, good.body)],
        ["wrong key", await send(sign({ key: newKey() }).headers, good.body)],
        ["tampered body", await send(good.headers, JSON.stringify({ ...body, running_jobs: 5 }))],
        ["other path", await send(good.headers, good.body, `${JUDGE}/node/other`)],
        ["too old", await send(sign({ timestampMs: nowMs - 61_000 }).headers, good.body)],
        ["from the future", await send(sign({ timestampMs: nowMs + 61_000 }).headers, good.body)],
        [
            "unknown node",
            await send(
                sign({ nodeId: "nod_018f0000-0000-7000-8000-0000000000aa" }).headers,
                good.body,
            ),
        ],
        [
            "garbage signature",
            await send({ ...good.headers, "x-aura-signature": "A".repeat(86) }, good.body),
        ],
    ];
}

describe("authentication", () => {
    it("answers every failure with the same bare 401", async () => {
        const node = await enrolled();
        const bodies = new Set<string>();
        for (const [label, response] of await unacceptableHeartbeats(node)) {
            expect(response.status, label).toBe(401);
            const { request_id: _ignored, ...rest } = problemSchema.parse(await response.json());
            bodies.add(JSON.stringify(rest));
        }
        expect(bodies.size).toBe(1);
    });
});

describe("authentication: replays and revocation", () => {
    it("refuses a repeated request, even one that failed the first time", async () => {
        const node = await enrolled();
        const target = `${JUDGE}/node/heartbeat`;
        const good = signedRequest(
            "POST",
            target,
            { agent_version: "0.1.0", canary_ok: true, running_jobs: 0 },
            { ...node, nowMs: h.clock.nowUnixMs() },
        );
        const send = () =>
            h.app().request(target, { method: "POST", headers: good.headers, body: good.body });
        expect((await send()).status).toBe(200);
        expect((await send()).status).toBe(401);
        const bad = signedRequest(
            "POST",
            target,
            { nonsense: true },
            { ...node, nowMs: h.clock.nowUnixMs() },
        );
        const sendBad = () =>
            h.app().request(target, { method: "POST", headers: bad.headers, body: bad.body });
        expect((await sendBad()).status).toBe(400);
        expect((await sendBad()).status).toBe(401);
    });

    it("stops a revoked node at once", async () => {
        const node = await enrolled();
        expect((await heartbeat(node)).status).toBe(200);
        const admin = await h.login(ALICE);
        const revoke = await h.request(`/admin/judge-nodes/${node.nodeId}/revoke`, {
            method: "POST",
            headers: browser(admin.token),
        });
        expect(revoke.status).toBe(204);
        expect((await heartbeat(node)).status).toBe(401);
        const again = await h.request(`/admin/judge-nodes/${node.nodeId}/revoke`, {
            method: "POST",
            headers: browser(admin.token),
        });
        expect(again.status).toBe(404);
    });

    it("covers every route under /judge/v1 except enrollment", () => {
        const routes = h.app().routes.filter((r) => r.path.startsWith(JUDGE) && r.method !== "ALL");
        const open = routes.filter((r) => !r.path.endsWith("/enroll"));
        expect(open.length).toBeGreaterThan(0);
        for (const route of open) expect(route.path).toMatch(/\/(node|lease|jobs|bundles)/);
    });
});

describe("the signature fixture", () => {
    it("matches what the control plane verifies, so the Go agent can check itself against it", () => {
        const fixture = JSON.parse(readFileSync(SIGNATURE_FIXTURE_PATH, "utf8"));
        expect(fixture).toEqual(signatureFixture());
    });
});

describe("attestation", () => {
    it("is development unless the administrator names production, and never changes", async () => {
        const plain = await enrolled();
        const production = await enrolled("production");
        const kindOf = async (nodeId: string) =>
            (
                await h.db.database.sql<{ attestation: string }[]>`
                select attestation from judge_nodes where id = ${decodeId("nod", nodeId)}`
            )[0]?.attestation;
        expect(await kindOf(plain.nodeId)).toBe("development");
        expect(await kindOf(production.nodeId)).toBe("production");
        await expect(
            h.db.database
                .sql`update judge_nodes set attestation = 'production' where id = ${decodeId("nod", plain.nodeId)}`,
        ).rejects.toThrow(/keeps its name, key and attestation/);
    });

    it("refuses an unknown attestation and an unknown field", async () => {
        const { token } = await h.login(ALICE);
        for (const body of [{ attestation: "staging" }, { attestations: "production" }]) {
            const response = await h.request("/admin/judge-nodes/enrollments", {
                method: "POST",
                headers: { ...browser(token), "content-type": "application/json" },
                body: JSON.stringify(body),
            });
            expect(response.status).toBe(400);
        }
    });
});
