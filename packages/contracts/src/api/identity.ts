import { z } from "zod";
import { authMethodSchema, emailSchema } from "../identity.ts";
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
        deletion_requested_at: z.iso.datetime().nullable(),
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

// ---- email sign-in ----

export const emailStartRequestSchema = z.object({ email: emailSchema }).strict();

const LOGIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// Generous cap: people paste codes with spaces or dashes. The server normalizes and checks digits.
const CODE_INPUT_LENGTH_MAX = 32;

// Exactly one proof: the token from the emailed link, or the typed code.
export const emailVerifyRequestSchema = z.union([
    z.object({ token: z.string().regex(LOGIN_TOKEN_PATTERN) }).strict(),
    z.object({ code: z.string().max(CODE_INPUT_LENGTH_MAX) }).strict(),
]);
export type EmailVerifyRequest = z.infer<typeof emailVerifyRequestSchema>;

export const emailStartResponseSchema = z.object({ status: z.literal("sent") }).strict();

export const emailVerifyResponseSchema = z
    .object({ status: z.literal("signed_in"), new_account: z.boolean() })
    .strict();
