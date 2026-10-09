import { z } from "zod";
import { authMethodSchema } from "../identity.ts";
import { idSchema } from "../ids.ts";

// Response shapes for the identity routes. `.strict()` makes them allowlists: a field that is not
// listed here cannot be serialized, which is how the API avoids leaking a column by accident.

export const meResponseSchema = z
    .object({
        id: idSchema("usr"),
        email: z.string(),
        email_verified: z.boolean(),
        // Null until the person has a profile.
        handle: z.string().nullable(),
        display_name: z.string().nullable(),
        platform_role: z.enum(["none", "admin"]),
    })
    .strict();
export type MeResponse = z.infer<typeof meResponseSchema>;

export const deviceSchema = z
    .object({
        id: idSchema("ses"),
        auth_method: authMethodSchema,
        created_at: z.iso.datetime(),
        last_seen_at: z.iso.datetime(),
        idle_expires_at: z.iso.datetime(),
        absolute_expires_at: z.iso.datetime(),
        ip_network: z.string().nullable(),
        user_agent: z.string().nullable(),
        // True for the session that made this request.
        current: z.boolean(),
    })
    .strict();

export const sessionsResponseSchema = z.object({ items: z.array(deviceSchema) }).strict();
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;
