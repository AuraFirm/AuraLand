import { z } from "zod";
import { orgNameSchema } from "../identity.ts";
import { idSchema } from "../ids.ts";

// Request and response shapes for organization API keys.

export const API_KEY_SCOPE_NAMES = ["org:read"] as const;
export const apiKeyScopeSchema = z.enum(API_KEY_SCOPE_NAMES);

export const API_KEY_EXPIRY_DAYS_DEFAULT = 90;
export const API_KEY_EXPIRY_DAYS_MAX = 365;

export const apiKeyCreateRequestSchema = z
    .object({
        name: orgNameSchema.max(80),
        scopes: z
            .array(apiKeyScopeSchema)
            .min(1)
            .max(API_KEY_SCOPE_NAMES.length)
            .default(["org:read"]),
        expires_in_days: z
            .number()
            .int()
            .min(1)
            .max(API_KEY_EXPIRY_DAYS_MAX)
            .default(API_KEY_EXPIRY_DAYS_DEFAULT),
    })
    .strict();

export const apiKeySchema = z
    .object({
        id: idSchema("key"),
        name: z.string(),
        // The public part of the key, so people can tell their keys apart. Not a secret.
        prefix: z.string(),
        scopes: z.array(z.string()),
        created_at: z.iso.datetime(),
        expires_at: z.iso.datetime(),
        revoked_at: z.iso.datetime().nullable(),
        last_used_at: z.iso.datetime().nullable(),
    })
    .strict();

export type ApiKeyItem = z.infer<typeof apiKeySchema>;

export const apiKeysResponseSchema = z.object({ items: z.array(apiKeySchema) }).strict();

// The one response that carries the whole key. It is shown once and cannot be fetched again.
export const apiKeyCreatedSchema = apiKeySchema.extend({ key: z.string() }).strict();

export const keyIntrospectionSchema = z
    .object({
        key: z.object({ id: idSchema("key"), scopes: z.array(z.string()) }).strict(),
        org: z
            .object({
                id: idSchema("org"),
                slug: z.string(),
                name: z.string(),
                verification_state: z.enum(["unverified", "verified"]),
            })
            .strict(),
    })
    .strict();
