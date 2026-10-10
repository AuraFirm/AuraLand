import { type ErrorCode, isErrorCode, problemSchema } from "@aura/contracts/errors";
import type { z } from "zod";

// The browser's way to call our API. Every request carries the custom header the API requires on
// state-changing requests (a cross-site page cannot add it), uses the same origin, and has its answer
// parsed by the same schema the server used to produce it, so a drift between the two fails loudly.

export class ApiError extends Error {
    readonly status: number;
    readonly code: ErrorCode | "unknown";
    constructor(status: number, code: ErrorCode | "unknown", title: string) {
        super(title);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
    }
}

interface RequestOptions {
    readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
    readonly body?: unknown;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
    const response = await fetch(`/api/v1${path}`, {
        method: options.method ?? "GET",
        headers: {
            "x-aura-request": "1",
            ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        credentials: "same-origin",
        cache: "no-store",
    });
    if (response.ok) return response;
    const problem = problemSchema.safeParse(await response.json().catch(() => null));
    if (!problem.success) throw new ApiError(response.status, "unknown", "Something went wrong");
    const code = isErrorCode(problem.data.code) ? problem.data.code : "unknown";
    throw new ApiError(response.status, code, problem.data.title);
}

export async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return schema.parse(await (await send(path, {})).json());
}

export async function apiSend<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions,
): Promise<T> {
    return schema.parse(await (await send(path, options)).json());
}

// For routes that answer 204 with no body.
export async function apiDo(path: string, options: RequestOptions): Promise<void> {
    await send(path, options);
}

export function messageOf(error: unknown): string {
    if (error instanceof ApiError) return error.message;
    return "Something went wrong. Try again.";
}
