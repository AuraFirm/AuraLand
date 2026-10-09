// Goal: a flaky registry must be retried, a dead one skipped, and total failure reported loudly.
import { describe, expect, it } from "vitest";
import {
    ATTEMPTS_PER_SOURCE,
    BACKOFF_MS_BASE,
    type PullDeps,
    pullFirstAvailable,
} from "./docker-pull.ts";

function fakeDeps(failuresByReference: Record<string, number>) {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const remaining = { ...failuresByReference };
    const deps: PullDeps = {
        pull(reference) {
            calls.push(reference);
            const left = remaining[reference] ?? 0;
            if (left > 0) {
                remaining[reference] = left - 1;
                throw new Error("simulated pull failure");
            }
        },
        sleep: (ms) => void sleeps.push(ms),
        log: () => undefined,
    };
    return { deps, calls, sleeps };
}

describe("pullFirstAvailable", () => {
    it("returns the first source immediately when it works", () => {
        const { deps, calls, sleeps } = fakeDeps({});
        expect(pullFirstAvailable(["a", "b"], deps)).toBe("a");
        expect(calls).toEqual(["a"]);
        expect(sleeps).toEqual([]);
    });

    it("retries a flaky source with growing waits before succeeding", () => {
        const { deps, calls, sleeps } = fakeDeps({ a: 2 });
        expect(pullFirstAvailable(["a", "b"], deps)).toBe("a");
        expect(calls).toEqual(["a", "a", "a"]);
        expect(sleeps).toEqual([BACKOFF_MS_BASE, BACKOFF_MS_BASE * 2]);
    });

    it("falls back to the next source after exhausting attempts on a dead one", () => {
        const { deps, calls } = fakeDeps({ a: ATTEMPTS_PER_SOURCE });
        expect(pullFirstAvailable(["a", "b"], deps)).toBe("b");
        expect(calls).toEqual(["a", "a", "a", "b"]);
    });

    it("does not wait after the last attempt on a source", () => {
        const { deps, sleeps } = fakeDeps({ a: ATTEMPTS_PER_SOURCE });
        pullFirstAvailable(["a", "b"], deps);
        expect(sleeps.length).toBe(ATTEMPTS_PER_SOURCE - 1);
    });

    it("throws when every source fails, and when no source is given", () => {
        const { deps, calls } = fakeDeps({ a: 99, b: 99 });
        expect(() => pullFirstAvailable(["a", "b"], deps)).toThrow(/any of 2 sources/);
        expect(calls.length).toBe(2 * ATTEMPTS_PER_SOURCE);
        expect(() => pullFirstAvailable([], deps)).toThrow(/no image sources/);
    });
});
