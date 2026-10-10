import { assert } from "@aura/contracts/assert";

// The only module allowed to call fetch (Semgrep rule aura-no-direct-http). It talks to one fixed,
// operator-configured origin, such as the mail service, and nothing else: the destination can never
// be influenced by user input, so it needs no address filtering. A client for user-supplied URLs
// (webhooks) is a different, much stricter thing and will be built when that feature exists.

export class EgressError extends Error {
    override readonly name = "EgressError";
}

export interface EgressOptions {
    readonly timeoutMs?: number;
    readonly responseBytesMax?: number;
}

export interface EgressReply {
    readonly status: number;
    readonly text: string;
}

export interface FixedOriginClient {
    postJson(path: string, body: unknown): Promise<EgressReply>;
    // A form-encoded POST, which OAuth token endpoints require. `headers` come from our own code.
    postForm(
        path: string,
        fields: Readonly<Record<string, string>>,
        headers?: Readonly<Record<string, string>>,
    ): Promise<EgressReply>;
    getJson(path: string, headers?: Readonly<Record<string, string>>): Promise<EgressReply>;
}

const TIMEOUT_MS_DEFAULT = 5_000; // A mail API that takes longer is effectively down.
const RESPONSE_BYTES_DEFAULT = 64 * 1024; // We only ever read small status replies.

function assertOrigin(origin: string): void {
    let parsed: URL;
    try {
        parsed = new URL(origin);
    } catch {
        throw new Error("egress origin must be a bare http(s) origin");
    }
    const bare =
        (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === origin;
    assert(bare, "egress origin must be a bare http(s) origin");
}

// Accepts only a plain absolute path. Anything that could turn into a different host, a relative
// reference or an injected header is refused before a URL is built.
function assertSafePath(path: string): void {
    const ok =
        /^\/[A-Za-z0-9._~\-/]*$/.test(path) && !path.startsWith("//") && !path.includes("..");
    assert(ok, "egress path must be a plain absolute path");
}

async function readCapped(response: Response, bytesMax: number): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    // unbounded: ends when the stream ends or the byte cap below throws
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > bytesMax) {
            await reader.cancel();
            throw new EgressError("response too large");
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function assertSafeHeaders(headers: Readonly<Record<string, string>>): void {
    for (const [name, value] of Object.entries(headers)) {
        assert(/^[A-Za-z][A-Za-z0-9-]*$/.test(name), "egress header name is a token");
        assert(!/[\r\n]/.test(value), "egress header value has no line break");
    }
}

export function createFixedOriginClient(
    origin: string,
    options: EgressOptions = {},
): FixedOriginClient {
    assertOrigin(origin);
    const timeoutMs = options.timeoutMs ?? TIMEOUT_MS_DEFAULT;
    const bytesMax = options.responseBytesMax ?? RESPONSE_BYTES_DEFAULT;

    async function send(path: string, init: RequestInit): Promise<EgressReply> {
        assertSafePath(path);
        try {
            const response = await fetch(new URL(path, origin), {
                ...init,
                redirect: "error",
                signal: AbortSignal.timeout(timeoutMs),
            });
            return { status: response.status, text: await readCapped(response, bytesMax) };
        } catch (error) {
            if (error instanceof EgressError) throw error;
            if (error instanceof Error && error.name === "TimeoutError") {
                throw new EgressError("request timed out");
            }
            // The cause can contain the address, so it is dropped here and logged by the caller
            // with its own context.
            throw new EgressError("request failed");
        }
    }

    return {
        postJson: (path, body) =>
            send(path, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            }),
        postForm(path, fields, headers = {}) {
            assertSafeHeaders(headers);
            return send(path, {
                method: "POST",
                headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams(fields).toString(),
            });
        },
        getJson(path, headers = {}) {
            assertSafeHeaders(headers);
            return send(path, { method: "GET", headers });
        },
    };
}
