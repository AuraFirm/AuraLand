import { z } from "zod";
import { envSpecSchema, isolationSchema } from "../environment.ts";
import { idSchema } from "../ids.ts";
import { ENV_FLAG_KINDS } from "../judge-protocol.ts";

// API shapes for environments and their runs (Stage 8, slice 8). The spec is the same strict schema the node reads.

export const createEnvironmentRequestSchema = z
    .object({
        slug: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/),
        title: z.string().min(1).max(120),
        spec: envSpecSchema,
        // Object-storage keys of the root file system and of the hidden material, uploaded beforehand.
        image_key: z.string().min(1).max(200),
        hidden_key: z.string().min(1).max(200),
        hidden_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict();

export const environmentSchema = z
    .object({
        id: idSchema("env"),
        org_id: idSchema("org"),
        slug: z.string(),
        title: z.string(),
        image_digest: z.string(),
        network: z.enum(["none", "allowlist"]),
        created_at: z.iso.datetime(),
    })
    .strict();
export const environmentsResponseSchema = z
    .object({ environments: z.array(environmentSchema) })
    .strict();

export const requestRunSchema = z
    .object({
        agent_label: z.string().min(1).max(80),
        // What the run is meant to support, so the control plane can say whether its isolation is enough.
        assurance_level: z.number().int().min(0).max(3).default(0),
        customer_delivery: z.boolean().default(false),
        customer_opted_in: z.boolean().default(false),
    })
    .strict()
    .refine(
        (run) => !run.customer_opted_in || run.customer_delivery,
        "opting in is for customer delivery",
    );

export const envRunSchema = z
    .object({
        id: idSchema("evr"),
        environment_id: idSchema("env"),
        agent_label: z.string(),
        state: z.enum(["queued", "done", "failed"]),
        isolation: isolationSchema.nullable(),
        outcome: z.enum(["completed", "setup_failed", "sandbox_error"]).nullable(),
        score: z.number().nullable(),
        // False for a result whose isolation is not enough for what the run was requested to support.
        eligible: z.boolean(),
        flags: z.array(
            z
                .object({
                    kind: z.enum(ENV_FLAG_KINDS),
                    subject: z.string(),
                    explanation: z.string(),
                })
                .strict(),
        ),
        created_at: z.iso.datetime(),
        finished_at: z.iso.datetime().nullable(),
    })
    .strict();
export const envRunsResponseSchema = z.object({ runs: z.array(envRunSchema) }).strict();
