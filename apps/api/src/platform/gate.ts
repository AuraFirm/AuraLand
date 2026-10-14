import { assert } from "@aura/contracts/assert";

// A counting gate: at most `concurrent` holders at once, a bounded first-in-first-out line behind them, and
// a refusal (null) when the line is full. Used where unbounded concurrency would exhaust something shared (the
// database pool) and where waiting forever is worse than saying "busy".

export interface Permit {
    // Gives the place back. Idempotent: a permit released twice frees one place once.
    release(): void;
}

export interface Gate {
    // Resolves with a permit when a place is free, or null at once if the line is already full.
    enter(): Promise<Permit | null>;
    // For tests and metrics.
    holders(): number;
    waiting(): number;
}

export function createGate(concurrent: number, waitingMax: number): Gate {
    assert(Number.isInteger(concurrent) && concurrent >= 1, "a gate lets at least one holder in");
    assert(Number.isInteger(waitingMax) && waitingMax >= 0, "the line has a bound");
    let holders = 0;
    const line: ((permit: Permit) => void)[] = [];
    // A place given back passes straight to the next in line (the count of holders does not move), or frees up.
    const onRelease = () => {
        const next = line.shift();
        if (next !== undefined) next(newPermit(onRelease));
        else holders--;
        assert(holders >= 0 && holders <= concurrent, "the gate never over- or under-fills");
    };
    return {
        enter() {
            if (holders < concurrent) {
                holders++;
                return Promise.resolve(newPermit(onRelease));
            }
            if (line.length >= waitingMax) return Promise.resolve(null);
            return new Promise((resolve) => line.push(resolve));
        },
        holders: () => holders,
        waiting: () => line.length,
    };
}

function newPermit(onRelease: () => void): Permit {
    let released = false;
    return {
        release() {
            if (released) return;
            released = true;
            onRelease();
        },
    };
}
