// Reading PostgreSQL error details without importing the driver, so callers can turn an expected
// rule violation (a taken slug, the last owner leaving) into a typed answer instead of a crash.

export const UNIQUE_VIOLATION = "23505";
export const CHECK_VIOLATION = "23514";

export function postgresErrorCode(error: unknown): string | null {
    if (typeof error !== "object" || error === null || !("code" in error)) return null;
    return typeof error.code === "string" ? error.code : null;
}

export function postgresConstraint(error: unknown): string | null {
    if (typeof error !== "object" || error === null || !("constraint_name" in error)) return null;
    return typeof error.constraint_name === "string" ? error.constraint_name : null;
}
