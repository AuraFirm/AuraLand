import { isIPv4, isIPv6 } from "node:net";

// Where a request really came from, for rate limits and the coarse network shown on a session.
// A forwarded header is believed only when the deployment says a trusted edge sets it; otherwise
// anyone could pick their own address and dodge the limits.

// Returns the canonical text of an address, or null if the text is not exactly one address.
export function parseAddress(text: string): string | null {
    if (isIPv4(text)) return text;
    if (!isIPv6(text)) return null;
    const lower = text.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1] !== undefined && isIPv4(mapped[1])) return mapped[1];
    return lower;
}

export interface AddressSources {
    readonly trustEdge: boolean;
    readonly forwardedFor: string | null;
    readonly socket: string | null;
}

// The edge appends the address it saw as the last entry; earlier entries come from the client and
// are ignored.
export function pickClientAddress(sources: AddressSources): string | null {
    if (sources.trustEdge && sources.forwardedFor !== null) {
        const last = sources.forwardedFor.split(",").at(-1)?.trim() ?? "";
        const parsed = parseAddress(last);
        if (parsed !== null) return parsed;
    }
    return sources.socket === null ? null : parseAddress(sources.socket);
}

const IPV6_GROUPS = 8;
const IPV6_NETWORK_GROUPS = 3; // 3 groups of 16 bits = /48

function expandIpv6(address: string): string[] {
    const [head = "", tail] = address.split("::");
    const front = head === "" ? [] : head.split(":");
    const back = tail === undefined || tail === "" ? [] : tail.split(":");
    const fill = tail === undefined ? 0 : IPV6_GROUPS - front.length - back.length;
    return [...front, ...Array<string>(fill).fill("0"), ...back];
}

// /24 for IPv4 and /48 for IPv6: enough to tell devices apart for a person, too coarse to track one.
export function ipNetwork(address: string): string {
    if (isIPv4(address)) return `${address.split(".").slice(0, 3).join(".")}.0/24`;
    const groups = expandIpv6(address).slice(0, IPV6_NETWORK_GROUPS);
    const trimmed = groups.map((group) => group.replace(/^0+(?=.)/, ""));
    return `${trimmed.join(":")}::/48`;
}
