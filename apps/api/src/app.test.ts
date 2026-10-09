// Goal: the HTTP shell must answer health probes, map every failure to problem+json without
// leaking internals, apply security headers and limits, and ask the process to stop on an
// invariant violation. Tests drive the real Hono app in memory.
import { InvariantError } from "@aura/contracts/assert";
import { problemSchema } from "@aura/contracts/errors";
import { REQUEST_BODY_BYTES_MAX } from "@aura/contracts/limits";
import { createTestDatabase, type TestDatabase } from "@aura/db/test-helpers";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type AppDeps, createApp } from "./app.ts";
import { parseConfig } from "./config.ts";
import { assertPipelineOrder, PIPELINE_ORDER } from "./pipeline.ts";
import { createFakeClock, createSeededRng } from "./sim/world.ts";

const baseEnv = {
    AURA_ENV: "test",
    AURA_ROLE: "http",
    AURA_HTTP_HOST: "127.0.0.1",
    AURA_HTTP_PORT: "3001",
    AURA_DATABASE_URL: "postgres://localhost/none",
    AURA_LOG_LEVEL: "error",
    AURA_TRUST_EDGE_REQUEST_ID: "false",
    AURA_PUBLIC_ORIGIN: "http://localhost:3000",
};

// These tests exercise the shell (probes, headers, errors), not /v1, but the app needs a database
// object to be built at all, so they get a real throwaway one.
let db: TestDatabase;
beforeAll(async () => {
    db = await createTestDatabase(1);
});
afterAll(async () => {
    await db.drop();
});

function makeApp(overrides: Partial<AppDeps> = {}, env: Record<string, string> = {}) {
    const deps: AppDeps = {
        config: parseConfig({ ...baseEnv, ...env }),
        // Expected errors are asserted on responses; the log output would only be noise here.
        logger: pino({ level: "silent" }),
        clock: createFakeClock(0),
        rng: createSeededRng(1),
        database: db.database,
        pingDatabase: async () => undefined,
        onInvariantViolation: () => undefined,
        ...overrides,
    };
    return createApp(deps);
}

describe("health probes", () => {
    it("liveness answers without touching dependencies", async () => {
        const pingDatabase = vi.fn(async () => undefined);
        const response = await makeApp({ pingDatabase }).request("/api/healthz");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: "ok" });
        expect(pingDatabase).not.toHaveBeenCalled();
    });

    it("readiness is 200 when the database answers and 503 problem+json when it does not", async () => {
        expect((await makeApp().request("/api/readyz")).status).toBe(200);
        const down = makeApp({ pingDatabase: async () => Promise.reject(new Error("pg down")) });
        const response = await down.request("/api/readyz");
        expect(response.status).toBe(503);
        expect(response.headers.get("content-type")).toContain("application/problem+json");
        const body = problemSchema.parse(await response.json());
        expect(body.code).toBe("unavailable");
        expect(JSON.stringify(body)).not.toContain("pg down");
    });
});

describe("request id", () => {
    it("generates an id and ignores the inbound header unless the edge is trusted", async () => {
        const response = await makeApp().request("/api/healthz", {
            headers: { "x-request-id": "evil" },
        });
        expect(response.headers.get("x-request-id")).not.toBe("evil");
        const trusted = makeApp({}, { AURA_TRUST_EDGE_REQUEST_ID: "true" });
        const ok = await trusted.request("/api/healthz", { headers: { "x-request-id": "edge-1" } });
        expect(ok.headers.get("x-request-id")).toBe("edge-1");
    });

    it("rejects malformed or oversized inbound ids even from the edge", async () => {
        const trusted = makeApp({}, { AURA_TRUST_EDGE_REQUEST_ID: "true" });
        for (const bad of ["a b", "x".repeat(65), "aé"]) {
            const response = await trusted.request("/api/healthz", {
                headers: { "x-request-id": bad },
            });
            expect(response.headers.get("x-request-id")).not.toBe(bad);
        }
        const edge = await trusted.request("/api/healthz", {
            headers: { "x-request-id": "x".repeat(64) },
        });
        expect(edge.headers.get("x-request-id")).toBe("x".repeat(64));
    });
});

describe("security headers", () => {
    it("sends the strict JSON-API policy and no-store caching", async () => {
        const response = await makeApp().request("/api/healthz");
        expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
        expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
        expect(response.headers.get("strict-transport-security")).toContain("preload");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("cache-control")).toBe("no-store");
    });
});

describe("errors", () => {
    it("returns not_found problem+json for unknown routes", async () => {
        const response = await makeApp().request("/api/nope");
        expect(response.status).toBe(404);
        expect(problemSchema.parse(await response.json()).code).toBe("not_found");
    });

    it("rejects bodies over the limit at the boundary and accepts the limit exactly", async () => {
        const app = makeApp();
        const post = (size: number) =>
            app.request("/api/healthz", { method: "POST", body: "x".repeat(size) });
        // The route only serves GET, so an accepted body shows up as 404, not 413.
        expect((await post(REQUEST_BODY_BYTES_MAX)).status).toBe(404);
        expect((await post(REQUEST_BODY_BYTES_MAX + 1)).status).toBe(413);
    });

    it("hides internal causes and asks the process to stop on an invariant violation", async () => {
        const onInvariantViolation = vi.fn();
        const app = makeApp({
            pingDatabase: async () => Promise.reject(new Error("unused")),
            onInvariantViolation,
        });
        app.get("/boom", () => {
            throw new InvariantError("secret internals");
        });
        const response = await app.request("/api/boom");
        expect(response.status).toBe(500);
        expect(JSON.stringify(await response.json())).not.toContain("secret");
        expect(onInvariantViolation).toHaveBeenCalledOnce();
    });

    it("treats ordinary exceptions as 500 without stopping the process", async () => {
        const onInvariantViolation = vi.fn();
        const app = makeApp({ onInvariantViolation });
        app.get("/oops", () => {
            throw new Error("bug");
        });
        expect((await app.request("/api/oops")).status).toBe(500);
        expect(onInvariantViolation).not.toHaveBeenCalled();
    });
});

describe("pipeline order", () => {
    it("accepts the canonical order and any ordered subset", () => {
        expect(() => assertPipelineOrder(PIPELINE_ORDER)).not.toThrow();
        expect(() => assertPipelineOrder(["requestId", "bodyLimit"])).not.toThrow();
    });

    it("rejects reordered, duplicated and unknown middleware", () => {
        expect(() => assertPipelineOrder(["bodyLimit", "requestId"])).toThrow(/out of order/);
        expect(() => assertPipelineOrder(["requestId", "requestId"])).toThrow(/out of order/);
        expect(() => assertPipelineOrder(["requestId", "cors"])).toThrow(/unknown/);
    });
});
