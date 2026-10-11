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

export const enrollmentCreatedSchema = z
    .object({ token: enrollmentTokenSchema, expires_at: z.iso.datetime() })
    .strict();

// ---- leasing and results ----

import { judgeLanguageSchema, testVerdictSchema } from "./judging.ts";
import { JOB_ERROR_CHARS_MAX, LEASE_WAIT_MS_MAX } from "./limits.ts";
import { taskSpecSchema } from "./tasks.ts";

export const leaseRequestSchema = z
    .object({
        queue: z.literal("judge"),
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
