import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

// Outbound requests to addresses a CUSTOMER chose (Stage 9 webhooks, docs/kit/06 section 5). Unlike the fixed-origin egress client,
// the destination here is hostile input, so everything is decided in this file and nowhere else:
//   - https only, ports 443 and 8443 only, a DNS name (never an IP literal), no credentials in the address;
//   - the name is resolved by OUR lookup function, which refuses the connection if ANY address is not public. Because the socket
//     connects to exactly the address that lookup returned, there is no gap between "checked" and "used" for DNS rebinding;
//   - no redirects are followed (a 3xx is a rejection), the response body is capped, and connecting and the whole exchange have
//     their own time limits;
//   - errors never carry the address or the text the remote sent back.
// Tests relax the policy through `options`; production code passes none.

export interface WebhookEgressOptions {
    readonly protocols?: readonly string[];
    readonly ports?: readonly number[];
    readonly isAllowedAddress?: (address: string) => boolean;
    readonly connectTimeoutMs?: number;
    readonly totalTimeoutMs?: number;
    readonly responseBytesMax?: number;
    // Replaces name resolution; tests use it to play a name server that lies.
    readonly resolve?: (hostname: string) => Promise<readonly LookupAddress[]>;
}

const CONNECT_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 10_000;
const RESPONSE_BYTES_MAX = 64 * 1024;
const PORTS_DEFAULT = [443, 8443] as const;
const HOSTNAME_BYTES_MAX = 253;
const URL_BYTES_MAX = 2_000;

// What a request to a customer-chosen address returned, with the same safeguards as a delivery: the text is capped and is only
// ever data (an identity provider's discovery document, a key set), never trusted before it is parsed and checked.
export type PublicResponse =
    | { readonly outcome: "response"; readonly status: number; readonly text: string }
    | { readonly outcome: "blocked"; readonly reason: string }
    | { readonly outcome: "failed"; readonly reason: string };

export type DeliveryResult =
    | { readonly outcome: "delivered"; readonly status: number }
    | { readonly outcome: "rejected"; readonly status: number }
    | { readonly outcome: "blocked"; readonly reason: string }
    | { readonly outcome: "failed"; readonly reason: string };

// Addresses a webhook may reach: global unicast only. Everything the kit names (private, loopback, link-local, metadata) and the
// rest of the reserved space is refused. IPv4-mapped IPv6 addresses are judged by the IPv4 address inside them.
export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) return isPublicV4(address.split(".").map(Number));
    if (family === 6) return isPublicV6(address.toLowerCase());
    return false;
}

function isPublicV4(p: readonly number[]): boolean {
    const [a, b, c] = [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-net, private, loopback, multicast and reserved
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local, including the cloud metadata address
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, documentation
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51 && c === 100) return false; // documentation
    if (a === 203 && b === 0 && c === 113) return false; // documentation
    return true;
}

function isPublicV6(address: string): boolean {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
    if (mapped !== null) return isPublicV4((mapped[1] ?? "").split(".").map(Number));
    const hextets = expandV6(address);
    if (hextets === null) return false;
    const first = hextets[0] ?? 0;
    if (hextets.every((h) => h === 0)) return false; // ::
    if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) return false; // ::1
    if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) return false; // other mapped forms
    if ((first & 0xfe00) === 0xfc00) return false; // unique local
    if ((first & 0xffc0) === 0xfe80) return false; // link-local
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (first === 0x2001 && hextets[1] === 0x0db8) return false; // documentation
    if (first === 0x0064 && hextets[1] === 0xff9b) return false; // NAT64 can reach IPv4 space we cannot see
    return (first & 0xe000) === 0x2000; // only the global unicast block is public
}

// Eight 16-bit groups, or null when the text is not a well-formed IPv6 address.
function expandV6(address: string): number[] | null {
    const halves = address.split("::");
    if (halves.length > 2) return null;
    const parse = (text: string) => (text === "" ? [] : text.split(":"));
    const [head, tail] = [parse(halves[0] ?? ""), parse(halves[1] ?? "")];
    const missing = 8 - head.length - tail.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
    const groups = [
        ...head,
        ...Array<string>(halves.length === 2 ? missing : 0).fill("0"),
        ...tail,
    ];
    const numbers = groups.map((g) =>
        /^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN,
    );
    return numbers.length === 8 && numbers.every((n) => !Number.isNaN(n)) ? numbers : null;
}

export type UrlVerdict =
    | { readonly ok: true; readonly url: URL }
    | { readonly ok: false; readonly reason: string };

// Checks the address a customer typed. Used when it is saved and again when it is used.
export function checkWebhookUrl(text: string, options: WebhookEgressOptions = {}): UrlVerdict {
    if (text.length > URL_BYTES_MAX) return { ok: false, reason: "too long" };
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return { ok: false, reason: "not an address" };
    }
    if (!(options.protocols ?? ["https:"]).includes(url.protocol))
        return { ok: false, reason: "https only" };
    if (url.username !== "" || url.password !== "")
        return { ok: false, reason: "no credentials in the address" };
    if (url.hash !== "") return { ok: false, reason: "no fragment" };
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0) return { ok: false, reason: "a name, not an IP address" };
    if (host.length === 0 || host.length > HOSTNAME_BYTES_MAX)
        return { ok: false, reason: "bad host" };
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    if (!(options.ports ?? PORTS_DEFAULT).includes(port))
        return { ok: false, reason: "port not allowed" };
    return { ok: true, url };
}

class BlockedAddressError extends Error {
    override readonly name = "BlockedAddressError";
}

function resolveAll(
    hostname: string,
    options: WebhookEgressOptions,
): Promise<readonly LookupAddress[]> {
    if (options.resolve !== undefined) return options.resolve(hostname);
    return new Promise((resolve, reject) => {
        dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) =>
            error === null ? resolve(addresses) : reject(error),
        );
    });
}

// The function the socket uses to find the address to connect to. It is the only place a name becomes an address.
function safeLookup(options: WebhookEgressOptions): NonNullable<https.RequestOptions["lookup"]> {
    const allowed = options.isAllowedAddress ?? isPublicAddress;
    return (hostname, lookupOptions, callback) => {
        resolveAll(hostname, options).then(
            (addresses) => {
                if (addresses.length === 0 || addresses.some((a) => !allowed(a.address))) {
                    callback(new BlockedAddressError("address not allowed"), "", 0);
                    return;
                }
                if (lookupOptions.all === true) callback(null, [...addresses]);
                else callback(null, addresses[0]?.address ?? "", addresses[0]?.family ?? 4);
            },
            (error: Error) => callback(error, "", 0),
        );
    };
}

export async function deliverWebhook(
    target: string,
    headers: Readonly<Record<string, string>>,
    body: string,
    options: WebhookEgressOptions = {},
): Promise<DeliveryResult> {
    const result = await requestPublic("POST", target, headers, body, options);
    if (result.outcome !== "response") return result;
    return result.status >= 200 && result.status < 300
        ? { outcome: "delivered", status: result.status }
        : { outcome: "rejected", status: result.status };
}

type Finish = (result: PublicResponse) => void;

// Reads the reply, stopping at the byte cap.
function collectResponse(response: http.IncomingMessage, bytesMax: number, finish: Finish): void {
    const chunks: Buffer[] = [];
    let received = 0;
    const status = response.statusCode ?? 0;
    response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > bytesMax) {
            response.destroy();
            finish({ outcome: "failed", reason: "response too large" });
            return;
        }
        chunks.push(chunk);
    });
    response.on("end", () =>
        finish({ outcome: "response", status, text: Buffer.concat(chunks).toString("utf8") }),
    );
    response.on("error", () => finish({ outcome: "failed", reason: "response failed" }));
}

// Connect time limit and error mapping. Reasons are fixed words: the real cause can hold the address or the remote's text.
function watchRequest(request: http.ClientRequest, connectTimeoutMs: number, finish: Finish): void {
    const connectTimer = setTimeout(
        () => request.destroy(new Error("connect timeout")),
        connectTimeoutMs,
    );
    request.on("socket", (socket) => socket.once("connect", () => clearTimeout(connectTimer)));
    request.on("close", () => clearTimeout(connectTimer));
    request.on("error", (error) => {
        if (error instanceof BlockedAddressError || error.cause instanceof BlockedAddressError)
            finish({ outcome: "blocked", reason: "address not allowed" });
        else if (error.name === "AbortError" || error.message === "connect timeout")
            finish({ outcome: "failed", reason: "timed out" });
        else finish({ outcome: "failed", reason: "request failed" });
    });
}

export function requestPublic(
    method: "GET" | "POST",
    target: string,
    headers: Readonly<Record<string, string>>,
    body: string,
    options: WebhookEgressOptions = {},
): Promise<PublicResponse> {
    const checked = checkWebhookUrl(target, options);
    if (!checked.ok) return Promise.resolve({ outcome: "blocked", reason: checked.reason });
    const { url } = checked;
    const client = url.protocol === "https:" ? https : http;
    return new Promise<PublicResponse>((resolve) => {
        let settled = false;
        const finish: Finish = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        const request = client.request(
            {
                protocol: url.protocol,
                hostname: url.hostname,
                port: url.port === "" ? undefined : Number(url.port),
                path: `${url.pathname}${url.search}`,
                method,
                headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
                lookup: safeLookup(options),
                signal: AbortSignal.timeout(options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS),
                agent: false,
            },
            (response) =>
                collectResponse(response, options.responseBytesMax ?? RESPONSE_BYTES_MAX, finish),
        );
        watchRequest(request, options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, finish);
        request.end(body);
    });
}
