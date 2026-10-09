// Anticipated failures are values, not exceptions (docs/kit/02 section 2.4). Unanticipated
// failures are exceptions and are bugs.

export type Result<T, E> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
    return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
    return { ok: false, error };
}
