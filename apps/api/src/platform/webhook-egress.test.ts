// Goal: a customer-chosen address can never make us reach inside. Every private, loopback, link-local, metadata and reserved
// address is refused, however it is spelled; the address that is checked is the address that is used (a name server that lies
// gets no connection); redirects, huge replies and slow servers end the delivery without following, reading or waiting forever.
// A real local server counts the connections it receives, so "blocked" means no connection was made.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkWebhookUrl, deliverWebhook, isPublicAddress } from "./webhook-egress.ts";

describe("isPublicAddress", () => {
    it("accepts ordinary public addresses", () => {
        for (const a of [
            "8.8.8.8",
            "1.1.1.1",
            "93.184.216.34",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
        ])
            expect(isPublicAddress(a), a).toBe(true);
    });

    it("refuses private, loopback, link-local, metadata, shared, multicast and reserved IPv4", () => {
        for (const a of [
            "0.0.0.0",
            "10.0.0.1",
            "10.255.255.255",
            "127.0.0.1",
            "127.255.255.254",
            "169.254.169.254",
            "169.254.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "100.64.0.1",
            "100.127.255.255",
            "192.0.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "198.19.255.255",
            "198.51.100.1",
            "203.0.113.9",
            "224.0.0.1",
            "239.255.255.255",
            "240.0.0.1",
            "255.255.255.255",
        ])
            expect(isPublicAddress(a), a).toBe(false);
    });

    it("keeps the edges of the private ranges exact", () => {
        for (const a of [
            "172.15.255.255",
            "172.32.0.0",
            "100.63.255.255",
            "100.128.0.0",
            "169.253.0.1",
            "169.255.0.1",
            "11.0.0.1",
            "126.255.255.255",
            "128.0.0.1",
        ])
            expect(isPublicAddress(a), a).toBe(true);
    });
});

describe("isPublicAddress, IPv6", () => {
    it("refuses loopback, unique-local, link-local, multicast, documentation, NAT64 and unspecified IPv6", () => {
        for (const a of [
            "::",
            "::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "febf::1",
            "ff02::1",
            "2001:db8::1",
            "64:ff9b::808:808",
            "0:0:0:0:0:0:0:1",
        ])
            expect(isPublicAddress(a), a).toBe(false);
    });

    it("judges an IPv4-mapped IPv6 address by the IPv4 address inside it", () => {
        expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
        expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false);
        expect(isPublicAddress("::ffff:169.254.169.254")).toBe(false);
        expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    });

    it("refuses what is not an address", () => {
        for (const a of [
            "",
            "localhost",
            "8.8.8",
            "8.8.8.8.8",
            "1.2.3.256",
            "::g",
            "2001:::1",
            "08.8.8.8",
        ])
            expect(isPublicAddress(a), a).toBe(false);
    });
});

describe("checkWebhookUrl", () => {
    it("accepts an https name on the allowed ports", () => {
        for (const u of [
            "https://hooks.example.com/aura",
            "https://hooks.example.com:8443/x?y=1",
            "https://a.b.example.com:443/",
        ])
            expect(checkWebhookUrl(u).ok, u).toBe(true);
    });

    it("refuses everything else", () => {
        for (const u of [
            "http://hooks.example.com/",
            "ftp://hooks.example.com/",
            "https://user:pw@hooks.example.com/",
            "https://hooks.example.com:80/",
            "https://hooks.example.com:8080/",
            "https://hooks.example.com/#frag",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://169.254.169.254/latest/meta-data",
            "https://2130706433/",
            "https://0x7f.1/",
            "not a url",
            "",
            `https://${"a".repeat(300)}.example.com/`,
            `https://x.example.com/${"a".repeat(2100)}`,
        ])
            expect(checkWebhookUrl(u).ok, u).toBe(false);
    });
});

let server: http.Server;
let port = 0;
let connections = 0;
let mode = "ok";
const permissive = { protocols: ["http:"], ports: [0], isAllowedAddress: () => true } as const;
const options = () => ({ ...permissive, ports: [port] });
const send = (url: string, extra: Parameters<typeof deliverWebhook>[3] = {}) =>
    deliverWebhook(url, { "content-type": "application/json" }, '{"a":1}', {
        ...options(),
        ...extra,
    });

beforeAll(async () => {
    server = http.createServer((request, response) => {
        request.resume();
        if (mode === "redirect") response.writeHead(302, { location: "http://127.0.0.1:1/" }).end();
        else if (mode === "huge") response.writeHead(200).end("x".repeat(200_000));
        else if (mode === "slow") setTimeout(() => response.writeHead(200).end(), 2_000);
        else if (mode === "fail") response.writeHead(500).end("secret internal text");
        else response.writeHead(200).end("ok");
    });
    server.on("connection", () => void connections++);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port; // tigerlint-allow: no-as-cast -- a listening TCP server always has an address object
});
afterAll(() => {
    server.closeAllConnections();
    server.close();
});

describe("deliverWebhook", () => {
    it("delivers to a server it is allowed to reach", async () => {
        mode = "ok";
        expect(
            await send(`http://hooks.test:${port}/p`, {
                resolve: async () => [{ address: "127.0.0.1", family: 4 }],
            }),
        ).toEqual({
            outcome: "delivered",
            status: 200,
        });
    });

    it("refuses loopback by default and never opens a connection", async () => {
        mode = "ok";
        const before = connections;
        const strict = { protocols: ["http:"], ports: [port] } as const;
        for (const resolved of [
            [{ address: "127.0.0.1", family: 4 }],
            [{ address: "::1", family: 6 }],
            [{ address: "169.254.169.254", family: 4 }],
            [{ address: "10.0.0.5", family: 4 }],
            // A name server that answers with one public and one private address is refused as a whole.
            [
                { address: "93.184.216.34", family: 4 },
                { address: "127.0.0.1", family: 4 },
            ],
            [],
        ]) {
            const result = await deliverWebhook(`http://rebind.test:${port}/p`, {}, "{}", {
                ...strict,
                resolve: async () => resolved,
            });
            expect(result, JSON.stringify(resolved)).toEqual({
                outcome: "blocked",
                reason: "address not allowed",
            });
        }
        expect(connections).toBe(before);
    });

    it("refuses a real name that resolves to loopback (localhost) with the default policy", async () => {
        const before = connections;
        const result = await deliverWebhook(`http://localhost:${port}/p`, {}, "{}", {
            protocols: ["http:"],
            ports: [port],
        });
        expect(result.outcome).toBe("blocked");
        expect(connections).toBe(before);
    });

    it("looks the name up once and connects to that very address", async () => {
        mode = "ok";
        let lookups = 0;
        const result = await send(`http://flip.test:${port}/p`, {
            resolve: async () => {
                lookups++;
                return [{ address: lookups === 1 ? "127.0.0.1" : "10.0.0.9", family: 4 }];
            },
        });
        expect(result.outcome).toBe("delivered");
        expect(lookups).toBe(1);
    });
});

describe("deliverWebhook, bad receivers", () => {
    it("does not follow a redirect", async () => {
        mode = "redirect";
        const result = await send(`http://hooks.test:${port}/p`, {
            resolve: async () => [{ address: "127.0.0.1", family: 4 }],
        });
        expect(result).toEqual({ outcome: "rejected", status: 302 });
    });

    it("reports a failing receiver by status alone, never by what it said", async () => {
        mode = "fail";
        const result = await send(`http://hooks.test:${port}/p`, {
            resolve: async () => [{ address: "127.0.0.1", family: 4 }],
        });
        expect(result).toEqual({ outcome: "rejected", status: 500 });
        expect(JSON.stringify(result)).not.toContain("secret");
    });

    it("stops reading a reply that is too large", async () => {
        mode = "huge";
        const result = await send(`http://hooks.test:${port}/p`, {
            resolve: async () => [{ address: "127.0.0.1", family: 4 }],
            responseBytesMax: 1024,
        });
        expect(result).toEqual({ outcome: "failed", reason: "response too large" });
    });

    it("gives up on a server that does not answer in time", async () => {
        mode = "slow";
        const result = await send(`http://hooks.test:${port}/p`, {
            resolve: async () => [{ address: "127.0.0.1", family: 4 }],
            totalTimeoutMs: 300,
        });
        expect(result).toEqual({ outcome: "failed", reason: "timed out" });
    });

    it("refuses an address the policy forbids before doing anything", async () => {
        const result = await deliverWebhook("https://127.0.0.1/hook", {}, "{}");
        expect(result.outcome).toBe("blocked");
    });
});
