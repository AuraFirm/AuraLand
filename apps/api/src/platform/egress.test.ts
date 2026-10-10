// Goal: the outbound client may talk to exactly one configured origin, never follow a redirect,
// give up on slow servers, refuse oversized replies, and never let a path change the destination.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixedOriginClient, EgressError } from "./egress.ts";
import { startTestServer, type TestServer } from "./test-helpers.ts";

let server: TestServer;
let origin = "";
const seen: Array<{ method: string; url: string; body: string; contentType: string | undefined }> =
    [];

beforeAll(async () => {
    server = await startTestServer((request, body, response) => {
        seen.push({
            method: request.method ?? "",
            url: request.url ?? "",
            body,
            contentType: request.headers["content-type"],
        });
        if (request.url === "/ok") response.end('{"fine":true}');
        else if (request.url === "/created") response.writeHead(201).end("made");
        else if (request.url === "/redirect") response.writeHead(302, { location: "/ok" }).end();
        else if (request.url === "/boom")
            response.writeHead(500).end("internal detail that must not leak");
        else if (request.url === "/huge") response.end("x".repeat(5000));
        else if (request.url === "/slow") setTimeout(() => response.end("late"), 1500);
        else response.writeHead(404).end();
    });
    origin = server.origin;
});
afterAll(async () => {
    await server.close();
});

const client = () => createFixedOriginClient(origin, { timeoutMs: 300, responseBytesMax: 1000 });

describe("postJson", () => {
    it("sends JSON to the configured origin and returns status and text", async () => {
        const result = await client().postJson("/ok", { a: 1 });
        expect(result).toEqual({ status: 200, text: '{"fine":true}' });
        const last = seen.at(-1);
        expect(last).toMatchObject({
            method: "POST",
            url: "/ok",
            body: '{"a":1}',
            contentType: "application/json",
        });
        expect((await client().postJson("/created", {})).status).toBe(201);
    });

    it("returns error statuses to the caller without throwing, and never logs the body for it", async () => {
        const result = await client().postJson("/boom", {});
        expect(result.status).toBe(500);
    });

    it("refuses to follow a redirect, even to a working page, because that could leave the origin", async () => {
        await expect(client().postJson("/redirect", {})).rejects.toBeInstanceOf(EgressError);
    });

    it("times out a slow server and refuses an oversized reply", async () => {
        await expect(client().postJson("/slow", {})).rejects.toThrow(/timed out/);
        await expect(client().postJson("/huge", {})).rejects.toThrow(/too large/);
    });
});

describe("destination safety", () => {
    it("rejects any path that could change the destination", async () => {
        for (const path of [
            "//evil.example/x",
            "http://evil.example/x",
            "ok",
            "/a/../../b",
            "/a\\b",
            "/ok\r\nHost: x",
            "",
        ]) {
            await expect(client().postJson(path, {}), path).rejects.toThrow(/path/);
        }
    });

    it("accepts only a bare origin when constructed", () => {
        for (const bad of [
            "http://127.0.0.1:8025/",
            "http://127.0.0.1:8025/x",
            "ftp://x",
            "x",
            "",
        ]) {
            expect(() => createFixedOriginClient(bad), bad).toThrow(/origin/);
        }
        expect(() => createFixedOriginClient("https://mail.example")).not.toThrow();
    });

    it("reports a connection failure as a typed error, without echoing the address", async () => {
        const dead = createFixedOriginClient("http://127.0.0.1:1", { timeoutMs: 300 });
        const failure = await dead.postJson("/x", {}).catch((e: unknown) => e);
        expect(failure).toBeInstanceOf(EgressError);
        expect(String(failure)).not.toContain("127.0.0.1");
    });
});
