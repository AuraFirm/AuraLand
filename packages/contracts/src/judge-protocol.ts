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
