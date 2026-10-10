import type { Context } from "hono";
import type { AppEnv } from "../../app-env.ts";
import { problemResponse } from "../../platform/problem-response.ts";
import type { Access, Membership } from "./access.ts";

// Small helpers every task route uses: who is calling, the common refusals, and JSON reading.

interface Caller {
    readonly userId: string;
    readonly orgs: readonly Membership[];
}

export function caller(c: Context<AppEnv>): Caller | null {
    const actor = c.get("actor");
    return actor.kind === "user" ? { userId: actor.userId, orgs: actor.orgs } : null;
}

export const unauthenticated = (c: Context<AppEnv>) =>
    problemResponse(c, "unauthenticated", "Authentication required");
export const invalid = (c: Context<AppEnv>) =>
    problemResponse(c, "invalid_request", "Invalid request");
export const notFound = (c: Context<AppEnv>) => problemResponse(c, "not_found", "Not found");
export const readJson = (c: Context<AppEnv>): Promise<unknown> =>
    c.req.json().then(
        (body: unknown) => body,
        () => null,
    );

export function refuse(c: Context<AppEnv>, decision: Access): Response | null {
    if (decision.allowed) return null;
    return decision.reason === "not_member"
        ? notFound(c)
        : problemResponse(c, "forbidden", "Forbidden");
}
