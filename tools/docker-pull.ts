import { execFileSync } from "node:child_process";

// Pulls a container image that is pinned by digest, trying several registries that serve the same
// bytes (ADR 0010). A transient failure ("unknown blob" from a mirror, a rate limit) on one source
// must not fail the build, but a digest mismatch can never happen: Docker verifies the pinned digest.

export const ATTEMPTS_PER_SOURCE = 3;
export const BACKOFF_MS_BASE = 2_000; // Waits 2 s, then 4 s, between attempts on one source.

export interface PullDeps {
    // Throws when the pull fails.
    pull(reference: string): void;
    sleep(ms: number): void;
    log(message: string): void;
}

// Returns the first reference that pulled successfully; throws when every source fails.
export function pullFirstAvailable(references: readonly string[], deps: PullDeps): string {
    if (references.length === 0) throw new Error("no image sources given");
    for (const reference of references) {
        for (let attempt = 1; attempt <= ATTEMPTS_PER_SOURCE; attempt++) {
            try {
                deps.pull(reference);
                return reference;
            } catch {
                deps.log(`pull failed (${attempt}/${ATTEMPTS_PER_SOURCE}): ${reference}`);
                if (attempt < ATTEMPTS_PER_SOURCE) deps.sleep(BACKOFF_MS_BASE * attempt);
            }
        }
    }
    throw new Error(`could not pull the image from any of ${references.length} sources`);
}

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const realPullDeps: PullDeps = {
    pull: (reference) =>
        void execFileSync("docker", ["pull", "--quiet", reference], { stdio: "inherit" }),
    sleep: sleepSync,
    log: (message) => void process.stderr.write(`${message}\n`),
};
