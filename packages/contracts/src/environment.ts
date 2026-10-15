import { z } from "zod";
import { assert } from "./assert.ts";
import {
    ENV_ARG_CHARS_MAX,
    ENV_CANARIES_MAX,
    ENV_COMMAND_ARGS_MAX,
    ENV_DISK_LIMIT_MIB_MAX,
    ENV_HONEYPOTS_MAX,
    ENV_MEMORY_LIMIT_MIB_MAX,
    ENV_MEMORY_LIMIT_MIB_MIN,
    ENV_NETWORK_ALLOW_MAX,
    ENV_PIDS_MAX,
    ENV_PROTECTED_PATHS_MAX,
    ENV_SETUP_COMMANDS_MAX,
    ENV_TIME_LIMIT_S_MAX,
    OUTPUT_LIMIT_KIB_MAX,
} from "./limits.ts";

// Tier-2 environments (Stage 8, ADR 0034; docs/kit/07 section 5). A recipe for a place an agent works in: an image, a
// command, limits, a network policy, and a verifier that runs elsewhere. Hidden material never appears in a spec: the
// verifier's files live in the bundle, outside the agent's image.

export const ENV_SPEC_VERSION = 2;
export const ENV_KINDS = ["repo_env", "agent_env"] as const;

// What contained a run. Only `firecracker` is the assurance the kit wants for customers; it is not built (F68).
export const ISOLATIONS = ["gvisor", "firecracker"] as const;
export const isolationSchema = z.enum(ISOLATIONS);
export type Isolation = z.infer<typeof isolationSchema>;

// A result produced under gVisor cannot earn a credential above assurance level 1 or be delivered to a customer as their
// score unless the customer opted in (kit 07 section 5.2). One function, so no caller restates the rule.
export function isolationAllows(
    isolation: Isolation,
    use: { assuranceLevel: number; customerDelivery: boolean; customerOptedIn: boolean },
): boolean {
    assert(use.assuranceLevel >= 0 && use.assuranceLevel <= 3, "assurance is 0 to 3");
    if (isolation === "firecracker") return true;
    if (use.customerDelivery && !use.customerOptedIn) return false;
    return use.assuranceLevel <= 1;
}

const argSchema = z
    .string()
    .min(1)
    .max(ENV_ARG_CHARS_MAX)
    .refine((text) => !text.includes("\0"), "no NUL byte");
// An argv, not a shell string: nothing is interpreted by a shell unless the recipe asks for one by name.
const argvSchema = z.array(argSchema).min(1).max(ENV_COMMAND_ARGS_MAX);

const absolutePathSchema = z
    .string()
    .min(2)
    .max(256)
    .regex(/^\/[A-Za-z0-9_./-]+$/, "an absolute path of plain characters")
    .refine((path) => !path.split("/").includes(".."), "no parent segments")
    .refine((path) => !path.endsWith("/") || path === "/", "no trailing slash");

// A DNS name only: an address literal would skip the pin-at-start resolution, and the names below are the ones that reach
// the host's own network.
const hostSchema = z
    .string()
    .min(3)
    .max(253)
    .regex(
        /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
        "a lower-case DNS name",
    )
    .refine(
        (host) => !/^(localhost|.*\.local|.*\.internal|.*\.localdomain)$/.test(host),
        "not a private name",
    )
    .refine((host) => !/^\d+(\.\d+){3}$/.test(host), "not an address literal");

const networkSchema = z
    .object({
        mode: z.enum(["none", "allowlist"]),
        allow: z
            .array(
                z.object({ host: hostSchema, port: z.number().int().min(1).max(65_535) }).strict(),
            )
            .max(ENV_NETWORK_ALLOW_MAX)
            .default([]),
    })
    .strict()
    .refine((network) => (network.mode === "none") === (network.allow.length === 0), {
        message: "none has no allowed destinations; an allowlist has at least one",
    });

const imageSchema = z
    .object({
        // The image is pinned by content, never by a tag that can move.
        digest: z.string().regex(/^sha256:[0-9a-f]{64}$/, "sha256: and 64 hex digits"),
        ref: z.string().max(200).optional(),
    })
    .strict();

const agentSchema = z
    .object({
        command: argvSchema,
        workspace: absolutePathSchema,
        time_limit_s: z.number().int().min(1).max(ENV_TIME_LIMIT_S_MAX),
        memory_limit_mib: z
            .number()
            .int()
            .min(ENV_MEMORY_LIMIT_MIB_MIN)
            .max(ENV_MEMORY_LIMIT_MIB_MAX),
        disk_limit_mib: z.number().int().min(16).max(ENV_DISK_LIMIT_MIB_MAX),
        pids_limit: z.number().int().min(8).max(ENV_PIDS_MAX),
        output_limit_kib: z.number().int().min(1).max(OUTPUT_LIMIT_KIB_MAX),
    })
    .strict();

const verifierSchema = z
    .object({
        command: argvSchema,
        time_limit_s: z.number().int().min(1).max(ENV_TIME_LIMIT_S_MAX),
        memory_limit_mib: z
            .number()
            .int()
            .min(ENV_MEMORY_LIMIT_MIB_MIN)
            .max(ENV_MEMORY_LIMIT_MIB_MAX),
        // How many per-run random values the hidden checks use, so a recorded answer to one run is useless in another.
        canaries: z.number().int().min(0).max(ENV_CANARIES_MAX),
    })
    .strict();

const integritySchema = z
    .object({
        // Paths the agent must not change (test runner config, the checker's inputs): hashed before and after.
        protected_paths: z.array(absolutePathSchema).max(ENV_PROTECTED_PATHS_MAX).default([]),
        // Files nobody honest reads; a read is a flag (evidence for a person, never a verdict).
        honeypots: z.array(absolutePathSchema).max(ENV_HONEYPOTS_MAX).default([]),
    })
    .strict();

export const envSpecSchema = z
    .object({
        spec_version: z.literal(ENV_SPEC_VERSION),
        kind: z.enum(ENV_KINDS),
        title: z.string().min(1).max(120),
        image: imageSchema,
        setup: z.array(argvSchema).max(ENV_SETUP_COMMANDS_MAX).default([]),
        agent: agentSchema,
        network: networkSchema,
        verifier: verifierSchema,
        integrity: integritySchema,
        scoring: z.object({ type: z.enum(["binary", "ratio"]) }).strict(),
    })
    .strict()
    .superRefine((spec, context) => {
        const overlap = spec.integrity.honeypots.filter((path) =>
            spec.integrity.protected_paths.includes(path),
        );
        if (overlap.length > 0) {
            context.addIssue({
                code: "custom",
                message: "a path is either protected or a honeypot, not both",
            });
        }
    });
export type EnvSpec = z.infer<typeof envSpecSchema>;
