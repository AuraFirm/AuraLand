import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { assert } from "@aura/contracts/assert";
import type { S3Settings } from "./storage-s3.ts";

// Helpers for tests that need a real HTTP server or the real Mailpit.

export interface TestServer {
    readonly origin: string;
    close(): Promise<void>;
}

export type TestHandler = (
    request: IncomingMessage,
    body: string,
    response: ServerResponse,
) => void;

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
}

// Starts a server on a free local port; the handler receives the request and its whole body.
export async function startTestServer(handler: TestHandler): Promise<TestServer> {
    const server: Server = createServer(async (request, response) => {
        handler(request, await readBody(request), response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address !== null && typeof address !== "string", "test server has a port");
    return {
        origin: `http://127.0.0.1:${address.port}`,
        async close() {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

// The URL of the local Mailpit. There is no default: a missing value fails the test.
export function mailpitUrl(): string {
    const url = process.env["AURA_TEST_MAILPIT_URL"];
    assert(
        url !== undefined && url.length > 0,
        "AURA_TEST_MAILPIT_URL must point to a running Mailpit",
    );
    return url;
}

// Connection settings for the local S3-compatible server (infra/compose.yml), with a bucket name the
// caller makes unique. There is no default: a missing value fails the test.
export function s3TestSettings(bucket: string): S3Settings {
    const read = (name: string): string => {
        const value = process.env[name];
        assert(
            value !== undefined && value.length > 0,
            `${name} must be set to run the storage tests`,
        );
        return value;
    };
    return {
        region: "us-east-1",
        bucket,
        endpoint: read("AURA_TEST_S3_ENDPOINT"),
        publicEndpoint: read("AURA_TEST_S3_ENDPOINT"),
        accessKeyId: read("AURA_TEST_S3_ACCESS_KEY"),
        secretAccessKey: read("AURA_TEST_S3_SECRET_KEY"),
    };
}
