import type { Result } from "./result.ts";

// The one door to a language model (kit 03). Callers give separate system and user text and get text back; they
// parse and validate it themselves, because model output is never an authority. No tools, no files, no secrets cross
// this port, and the user text is always treated as hostile by whoever builds it.
//
// Only the fake lives here: a real adapter needs a provider account and budget (owner item F41), and is built and
// tested when there is one. Until then nothing in the product claims to call a real model.

export interface LlmRequest {
    readonly system: string; // fixed instructions written by us
    readonly user: string; // data, possibly hostile
    readonly outputTokensMax: number;
}
export type LlmError = "unavailable" | "refused";
export interface LlmProvider {
    complete(request: LlmRequest): Promise<Result<string, LlmError>>;
}

// A scripted provider for tests and for local runs without a key. `reply` sees exactly what a real model would.
export function createFakeLlm(
    reply: (request: LlmRequest) => Result<string, LlmError>,
): LlmProvider {
    return { complete: async (request) => reply(request) };
}
