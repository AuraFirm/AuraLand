// Goal: prove the error contract is closed and total, so a new code cannot ship half-wired.
import { describe, expect, it } from "vitest";
import { ERROR_CODES, ERROR_STATUS, isErrorCode, problemSchema } from "./errors.ts";

describe("error contract", () => {
    it("maps every code to a 4xx or 5xx status", () => {
        for (const code of ERROR_CODES) {
            expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
        }
        expect(Object.keys(ERROR_STATUS).length).toBe(ERROR_CODES.length);
    });

    it("accepts a valid problem and rejects unknown fields", () => {
        const valid = {
            type: "about:blank",
            title: "Not found",
            status: 404,
            code: "not_found",
            request_id: "req-1",
        };
        expect(problemSchema.safeParse(valid).success).toBe(true);
        expect(problemSchema.safeParse({ ...valid, stack: "leak" }).success).toBe(false);
    });

    it("rejects codes outside the closed set and statuses below 400", () => {
        const base = { type: "about:blank", title: "x", request_id: "r" };
        expect(problemSchema.safeParse({ ...base, status: 404, code: "teapot" }).success).toBe(
            false,
        );
        expect(problemSchema.safeParse({ ...base, status: 399, code: "internal" }).success).toBe(
            false,
        );
        expect(isErrorCode("internal")).toBe(true);
        expect(isErrorCode("teapot")).toBe(false);
    });
});
