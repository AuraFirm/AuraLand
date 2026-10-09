import { z } from "zod";

// The closed set of machine-readable error codes. Clients switch on `code`, never on `title`,
// so adding a code is an API change: extend this tuple and handle it in every exhaustive switch.
export const ERROR_CODES = [
    "invalid_request",
    "unauthenticated",
    "forbidden",
    "not_found",
    "conflict",
    "payload_too_large",
    "rate_limited",
    "unavailable",
    "internal",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// HTTP status for each code. Declared as a total record so the compiler proves no code is missing.
export const ERROR_STATUS: Record<ErrorCode, 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503> =
    {
        invalid_request: 400,
        unauthenticated: 401,
        forbidden: 403,
        not_found: 404,
        conflict: 409,
        payload_too_large: 413,
        rate_limited: 429,
        unavailable: 503,
        internal: 500,
    };

// RFC 9457 problem details. `.strict()` so a leaked internal field fails the response-schema test.
export const problemSchema = z
    .object({
        type: z.string().min(1).max(200),
        title: z.string().min(1).max(200),
        status: z.number().int().min(400).max(599),
        code: z.enum(ERROR_CODES),
        detail: z.string().max(1000).optional(),
        request_id: z.string().min(1).max(64),
    })
    .strict();

export type Problem = z.infer<typeof problemSchema>;

export function isErrorCode(value: string): value is ErrorCode {
    return ERROR_CODES.some((code) => code === value);
}
