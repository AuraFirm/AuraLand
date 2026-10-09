import { ERROR_STATUS, type ErrorCode } from "@aura/contracts/errors";
import type { Context } from "hono";
import { buildProblem } from "./problem.ts";

// An RFC 9457 error response with the request id attached. Accepts any context because some Hono
// hooks (body limit) are not typed with our environment.
export function problemResponse(c: Context, code: ErrorCode, title: string, detail?: string) {
    const requestId = c.get("requestId");
    const body = buildProblem(
        code,
        title,
        typeof requestId === "string" ? requestId : "unknown",
        detail,
    );
    return c.json(body, ERROR_STATUS[code], { "Content-Type": "application/problem+json" });
}
