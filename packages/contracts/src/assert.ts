// Assertions are the second program (TigerStyle): they stay enabled in production. A failed
// assertion means a programmer error, so the only correct response is to stop this unit of work
// loudly. The process top level logs, flushes and exits; a supervisor restarts it clean.

export class InvariantError extends Error {
    override readonly name = "InvariantError";
}

export function assert(condition: boolean, message: string): asserts condition {
    if (!condition) {
        throw new InvariantError(`Invariant violated: ${message}`);
    }
}

// Exhaustiveness helper: a `switch` over a union ends with `assertNever(value)` so the compiler
// rejects an unhandled member and the runtime rejects a value that escaped the type system.
export function assertNever(value: never): never {
    throw new InvariantError(`Unreachable value: ${String(value)}`);
}
