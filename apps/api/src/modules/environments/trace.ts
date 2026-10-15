import { createHash, createPublicKey, verify } from "node:crypto";
import { type EnvTrace, envTraceSchema } from "@aura/contracts/judge-protocol";

// Reading a node's trace (Stage 8). The signature is checked over the exact bytes the node signed before they are parsed;
// then the shape is checked strictly and the parts must agree with each other. A trace that does not hold together is
// refused, never repaired. Nothing in a trace is trusted as a statement about the world: it is what an untrusted machine
// says happened, kept as evidence.

const TRACE_DOMAIN = "AURA-TRACE-V1";
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyTraceSignature(
    publicKey: Uint8Array,
    trace: string,
    signature: string,
): boolean {
    if (publicKey.length !== 32) return false;
    const digest = createHash("sha256").update(trace).digest("hex");
    try {
        const key = createPublicKey({
            key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]),
            format: "der",
            type: "spki",
        });
        return verify(
            null,
            Buffer.from(`${TRACE_DOMAIN}\n${digest}`),
            key,
            Buffer.from(signature, "base64url"),
        );
    } catch {
        return false;
    }
}

export type ReadTrace =
    | { readonly ok: true; readonly trace: EnvTrace; readonly score: number | null }
    | { readonly ok: false; readonly reason: string };

// What a finished run must look like, whatever the node says: a completed run has a verifier result and steps; a failed
// setup has neither a verifier result nor a score; a sandbox error has no score.
export function readTrace(text: string): ReadTrace {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return { ok: false, reason: "the trace is not JSON" };
    }
    const parsed = envTraceSchema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: "the trace has the wrong shape" };
    const trace = parsed.data;
    if (trace.outcome === "completed" && (trace.verifier === null || trace.steps.length === 0)) {
        return { ok: false, reason: "a completed run has steps and a verifier result" };
    }
    if (trace.outcome !== "completed" && trace.verifier !== null) {
        return { ok: false, reason: "only a completed run has a verifier result" };
    }
    const last = trace.steps[trace.steps.length - 1];
    if (trace.outcome === "completed" && last?.name !== "agent") {
        return { ok: false, reason: "a completed run ends with the agent step" };
    }
    return { ok: true, trace, score: trace.verifier?.score ?? null };
}
