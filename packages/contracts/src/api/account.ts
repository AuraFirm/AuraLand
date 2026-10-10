import { z } from "zod";
import { oauthProviderSchema } from "./oauth.ts";

// Account-level shapes: which sign-in methods are on, the personal data export, and the deletion request.

export const authMethodsResponseSchema = z
    .object({
        email: z.boolean(),
        passkey: z.literal(true),
        oauth: z.array(oauthProviderSchema),
    })
    .strict();

// Whether this browser has a session. Always answers 200, so asking never looks like an error.
export const sessionStatusSchema = z.object({ signed_in: z.boolean() }).strict();

export const revokedSessionsSchema = z.object({ revoked: z.number().int().min(0) }).strict();

export const deletionRequestResponseSchema = z
    .object({ deletion_requested_at: z.iso.datetime().nullable() })
    .strict();

// Everything we hold about the person that they can see, as one bounded document. Secrets and
// credential material (token hashes, public keys, counters) are never part of it.
export const exportSchema = z
    .object({
        exported_at: z.iso.datetime(),
        account: z
            .object({
                id: z.string(),
                email: z.string(),
                email_verified: z.boolean(),
                handle: z.string().nullable(),
                display_name: z.string().nullable(),
                created_at: z.iso.datetime(),
                deletion_requested_at: z.iso.datetime().nullable(),
            })
            .strict(),
        organizations: z.array(
            z
                .object({
                    id: z.string(),
                    slug: z.string(),
                    name: z.string(),
                    kind: z.string(),
                    role: z.string(),
                    joined_at: z.iso.datetime(),
                })
                .strict(),
        ),
        passkeys: z.array(
            z
                .object({
                    name: z.string(),
                    created_at: z.iso.datetime(),
                    last_used_at: z.iso.datetime().nullable(),
                })
                .strict(),
        ),
        identities: z.array(
            z
                .object({
                    provider: z.string(),
                    created_at: z.iso.datetime(),
                    last_login_at: z.iso.datetime().nullable(),
                })
                .strict(),
        ),
        sessions: z.array(
            z
                .object({
                    auth_method: z.string(),
                    created_at: z.iso.datetime(),
                    last_seen_at: z.iso.datetime(),
                    ip_network: z.string().nullable(),
                    user_agent: z.string().nullable(),
                })
                .strict(),
        ),
        audit: z.array(
            z
                .object({ at: z.iso.datetime(), action: z.string(), target: z.string().nullable() })
                .strict(),
        ),
    })
    .strict();
