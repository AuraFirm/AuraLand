import { z } from "zod";
import { idSchema } from "./ids.ts";

// The wire contract between the control plane and judge nodes (docs/kit/06 section 7). Both sides
// parse with these `.strict()` schemas: an unknown field is an error, never ignored. The Go agent
// mirrors them by hand and is checked against the JSON fixtures in `judge/fixtures/`.

export const NODE_HEADER = "x-aura-node";
export const TIMESTAMP_HEADER = "x-aura-timestamp";
export const NONCE_HEADER = "x-aura-nonce";
export const SIGNATURE_HEADER = "x-aura-signature";

export const SIGNATURE_DOMAIN = "AURA-NODE-V1";

const base64Url = (length: number) =>
    z
        .string()
        .length(length)
        .regex(/^[A-Za-z0-9_-]+$/);

// 32 random bytes in base64url: the enrollment token and the Ed25519 public key.
export const enrollmentTokenSchema = base64Url(43);
export const publicKeySchema = base64Url(43);

export const nodeNameSchema = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);
export const agentVersionSchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._+-]+$/);

export const enrollRequestSchema = z
    .object({
        token: enrollmentTokenSchema,
        name: nodeNameSchema,
        public_key: publicKeySchema,
        agent_version: agentVersionSchema,
        tiers: z
            .array(z.union([z.literal(1), z.literal(2)]))
            .min(1)
            .max(2),
    })
    .strict();

export const nodeStateSchema = z.enum(["enrolled", "active", "draining", "revoked"]);

export const enrollResponseSchema = z
    .object({ node_id: idSchema("nod"), state: nodeStateSchema })
    .strict();

export const nodeHeartbeatRequestSchema = z
    .object({
        agent_version: agentVersionSchema,
        // The result of the node's self-test (escape suite and timing calibration). A node becomes
        // active only after a passing one, and drains after a failing one.
        canary_ok: z.boolean(),
        running_jobs: z.number().int().min(0).max(1024),
    })
    .strict();

export const nodeHeartbeatResponseSchema = z.object({ state: nodeStateSchema }).strict();

// What the operator declares a node to be (ADR 0029): only a reviewed 'production' node may produce a
// validation report that a customer is told is validated.
export const nodeAttestationSchema = z.enum(["development", "production"]);
export type NodeAttestation = z.infer<typeof nodeAttestationSchema>;

export const enrollmentRequestSchema = z
    .object({ attestation: nodeAttestationSchema.default("development") })
    .strict();

export const enrollmentCreatedSchema = z
    .object({
        token: enrollmentTokenSchema,
        expires_at: z.iso.datetime(),
        attestation: nodeAttestationSchema,
    })
    .strict();

// ---- leasing and results ----

import { judgeLanguageSchema, testVerdictSchema } from "./judging.ts";
import { JOB_ERROR_CHARS_MAX, LEASE_WAIT_MS_MAX } from "./limits.ts";
import { taskSpecSchema } from "./tasks.ts";
import { validationJobSchema } from "./validation.ts";

export const leaseRequestSchema = z
    .object({
        queue: z.enum(["judge", "validate", "watermark", "env"]),
        // 0 answers at once; up to 25 s holds the request until work arrives.
        wait_ms: z.number().int().min(0).max(LEASE_WAIT_MS_MAX),
    })
    .strict();

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

// What a node needs to judge one submission. The test files come separately, from the bundle.
export const leasedJobSchema = z
    .object({
        job_id: idSchema("job"),
        lease_epoch: z.number().int().min(1),
        lease_ttl_s: z.number().int().min(1),
        kind: z.literal("judge.tier1"),
        submission: z
            .object({ id: idSchema("sub"), language: judgeLanguageSchema, source: z.string() })
            .strict(),
        task: z
            .object({
                version_id: idSchema("tsv"),
                bundle: z.object({ sha256: sha256Hex, bytes: z.number().int().min(1) }).strict(),
                spec: taskSpecSchema,
            })
            .strict(),
    })
    .strict();

export const leaseResponseSchema = z.object({ job: leasedJobSchema.nullable() }).strict();
// The answer to a lease on the validate queue: the other kind of job, so the two never get mixed up.
export const validationLeaseResponseSchema = z
    .object({ job: validationJobSchema.nullable() })
    .strict();

export const jobHeartbeatRequestSchema = z
    .object({ lease_epoch: z.number().int().min(1) })
    .strict();
export const jobHeartbeatResponseSchema = z
    .object({ lease_ttl_s: z.number().int().min(1) })
    .strict();

export const nodeTestResultSchema = z
    .object({
        test_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
        verdict: testVerdictSchema,
        cpu_ms: z.number().int().min(0).max(3_600_000),
        wall_ms: z.number().int().min(0).max(3_600_000),
        memory_kib: z.number().int().min(0).max(8_388_608),
        // Checker output is data from an untrusted machine: bounded, control characters stripped.
        checker_msg: z.string().max(2048).optional(),
    })
    .strict();

export const jobCompleteRequestSchema = z
    .object({
        lease_epoch: z.number().int().min(1),
        result: z
            .object({
                compile_ok: z.boolean(),
                compile_message: z.string().max(2048).optional(),
                tests: z.array(nodeTestResultSchema).max(1000),
            })
            .strict(),
    })
    .strict();

export const jobFailRequestSchema = z
    .object({
        lease_epoch: z.number().int().min(1),
        error: z.string().min(1).max(JOB_ERROR_CHARS_MAX),
        retryable: z.boolean(),
    })
    .strict();

export const jobAcceptedSchema = z.object({ accepted: z.literal(true) }).strict();

// Environment runs (Stage 8, ADR 0034): what a Tier-2 node is leased, and what it reports. The trace is sent as the exact
// text the node signed (canonical JSON), so the signature can be checked over those bytes before anything is parsed.
export const envJobSchema = z
    .object({
        job_id: idSchema("job"),
        lease_epoch: z.number().int().min(1),
        lease_ttl_s: z.number().int().min(1),
        run_id: idSchema("evr"),
        environment: z
            .object({
                id: idSchema("env"),
                spec: z.record(z.string(), z.unknown()),
                image_key: z.string(),
                image_download_url: z.string(),
                hidden_key: z.string(),
                hidden_download_url: z.string(),
                hidden_sha256: z.string().regex(/^[0-9a-f]{64}$/),
            })
            .strict(),
    })
    .strict();
export const envLeaseResponseSchema = z.object({ job: envJobSchema.nullable() }).strict();

const traceStepSchema = z
    .object({
        name: z.string().max(40),
        argv: z.array(z.string().max(512)).max(32),
        verdict: z.enum(["OK", "TLE", "MLE", "OLE", "RTE", "SE"]),
        exit_code: z.number().int(),
        wall_ms: z.number().int().min(0),
        peak_memory_mib: z.number().int().min(0),
        pids_peak: z.number().int().min(0),
        stdout_bytes: z.number().int().min(0),
        stdout_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        tree_hash: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict();
export const ENV_FLAG_KINDS = [
    "protected_path_changed",
    "honeypot_touched",
    "canary_in_output",
    "link_in_workspace",
] as const;
export const envTraceSchema = z
    .object({
        version: z.literal(1),
        isolation: z.enum(["gvisor", "firecracker"]),
        outcome: z.enum(["completed", "setup_failed", "sandbox_error"]),
        start_hash: z.string().regex(/^[0-9a-f]{64}$/),
        steps: z.array(traceStepSchema).max(200),
        flags: z
            .array(
                z
                    .object({
                        kind: z.enum(ENV_FLAG_KINDS),
                        subject: z.string().max(300),
                        explanation: z.string().max(600),
                    })
                    .strict(),
            )
            .max(100),
        verifier: z
            .object({
                score: z.number().min(0).max(1),
                detail: z.string().max(1024),
                dropped: z.array(z.string().max(300)).max(100),
            })
            .strict()
            .nullable(),
    })
    .strict();
export type EnvTrace = z.infer<typeof envTraceSchema>;
export const envCompleteRequestSchema = z
    .object({
        lease_epoch: z.number().int().min(1),
        trace: z.string().min(2).max(1_048_576),
        trace_signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    })
    .strict();
