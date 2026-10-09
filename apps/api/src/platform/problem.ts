import { ERROR_STATUS, type ErrorCode, type Problem } from "@aura/contracts/errors";

// Builds an RFC 9457 problem document. `detail` must already be safe to show to a client; internal
// causes are logged with the request id and never put here.
export function buildProblem(
    code: ErrorCode,
    title: string,
    requestId: string,
    detail?: string,
): Problem {
    const base = {
        type: "about:blank",
        title,
        status: ERROR_STATUS[code],
        code,
        request_id: requestId,
    };
    return detail === undefined ? base : { ...base, detail };
}
