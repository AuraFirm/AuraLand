import { z } from "zod";
import { idSchema } from "../ids.ts";

// Consented support access (Stage 9): a person lets support staff look at an account summary for a while. Read-only.
export const grantSupportRequestSchema = z
    .object({ hours: z.number().int().min(1).max(24) })
    .strict();

export const supportViewSchema = z
    .object({ viewed_at: z.iso.datetime(), admin_id: idSchema("usr") })
    .strict();
export const supportGrantSchema = z
    .object({
        id: idSchema("sgr"),
        created_at: z.iso.datetime(),
        expires_at: z.iso.datetime(),
        revoked: z.boolean(),
        views: z.array(supportViewSchema),
    })
    .strict();
export const supportGrantsResponseSchema = z
    .object({ grants: z.array(supportGrantSchema) })
    .strict();

export const supportOverviewSchema = z
    .object({
        email: z.string(),
        status: z.string(),
        created_at: z.string(),
        organizations: z.array(
            z.object({ name: z.string(), kind: z.string(), role: z.string() }).strict(),
        ),
        sessions: z.array(
            z
                .object({
                    auth_method: z.string(),
                    created_at: z.string(),
                    last_seen_at: z.string(),
                })
                .strict(),
        ),
        recent_actions: z.array(z.object({ action: z.string(), at: z.string() }).strict()),
    })
    .strict();
