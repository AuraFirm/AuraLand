// Goal: the address used for rate limits and the session's coarse network must come only from a
// source we trust, must be a real IP address, and must reduce to the documented network size.
import { describe, expect, it } from "vitest";
import { ipNetwork, parseAddress, pickClientAddress } from "./client-address.ts";

describe("parseAddress", () => {
    it("accepts IPv4 and IPv6, lowercases IPv6, unwraps IPv4-mapped addresses", () => {
        expect(parseAddress("203.0.113.7")).toBe("203.0.113.7");
        expect(parseAddress("2001:DB8::1")).toBe("2001:db8::1");
        expect(parseAddress("::ffff:203.0.113.7")).toBe("203.0.113.7");
    });

    it("rejects anything that is not exactly an address", () => {
        for (const bad of [
            "",
            "unknown",
            "203.0.113.7, 1.1.1.1",
            "203.0.113.256",
            " 1.2.3.4",
            "1.2.3.4:80",
            "a".repeat(100),
        ]) {
            expect(parseAddress(bad), bad).toBeNull();
        }
    });
});

describe("pickClientAddress", () => {
    it("uses the socket address when no trusted edge sits in front", () => {
        expect(
            pickClientAddress({ trustEdge: false, forwardedFor: "9.9.9.9", socket: "203.0.113.7" }),
        ).toBe("203.0.113.7");
    });

    it("uses the last forwarded entry (added by our edge) when the edge is trusted", () => {
        expect(
            pickClientAddress({
                trustEdge: true,
                forwardedFor: "6.6.6.6, 198.51.100.4",
                socket: "10.0.0.1",
            }),
        ).toBe("198.51.100.4");
    });

    it("falls back to the socket when the trusted header is missing, and to null when nothing is usable", () => {
        expect(pickClientAddress({ trustEdge: true, forwardedFor: null, socket: "10.0.0.1" })).toBe(
            "10.0.0.1",
        );
        expect(
            pickClientAddress({ trustEdge: true, forwardedFor: "junk", socket: "10.0.0.1" }),
        ).toBe("10.0.0.1");
        expect(
            pickClientAddress({ trustEdge: false, forwardedFor: null, socket: null }),
        ).toBeNull();
    });
});

describe("ipNetwork", () => {
    it("keeps /24 of IPv4 and /48 of IPv6", () => {
        expect(ipNetwork("203.0.113.77")).toBe("203.0.113.0/24");
        expect(ipNetwork("2001:db8:abcd:12:ffff::1")).toBe("2001:db8:abcd::/48");
        // Not compressed, but the same network always gives the same text.
        expect(ipNetwork("::1")).toBe("0:0:0::/48");
        expect(ipNetwork("2001:db8::")).toBe("2001:db8:0::/48");
    });

    it("matches the session network format", () => {
        expect(ipNetwork("2001:db8:1::5")).toMatch(/^[0-9a-f:.]+\/[0-9]{1,3}$/i);
    });
});
