import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { pickClientAddress } from "./platform/client-address.ts";

// Facts about the caller that routes use for rate limits, audit entries and the device list.

const USER_AGENT_LENGTH_MAX = 200; // Matches the sessions table constraint.

// The socket address exists only when served by the real Node server; in tests there is none.
export function clientAddress(c: Context, trustEdge: boolean): string | null {
    let socket: string | null = null;
    try {
        socket = getConnInfo(c).remote.address ?? null;
    } catch {
        // No socket behind this request (an in-process test call): fall back to the header only.
        socket = null;
    }
    return pickClientAddress({
        trustEdge,
        forwardedFor: c.req.header("x-forwarded-for") ?? null,
        socket,
    });
}

// Control characters are dropped so the value is safe to store and show; the rest is cut to fit.
export function userAgentOf(c: Context): string | null {
    const raw = c.req.header("user-agent") ?? "";
    const printable = [...raw]
        .filter((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code >= 0x20 && code !== 0x7f;
        })
        .join("");
    const cut = printable.slice(0, USER_AGENT_LENGTH_MAX);
    return cut === "" ? null : cut;
}
