import { z } from "zod";
import { emailSchema } from "../identity.ts";
import { idSchema } from "../ids.ts";

// Request and response shapes for organization invitations.

export const invitationCreateRequestSchema = z
    .object({ email: emailSchema, role: z.enum(["admin", "member"]).default("member") })
    .strict();

export const invitationSchema = z
    .object({
        id: idSchema("inv"),
        email: z.string(),
        role: z.enum(["admin", "member"]),
        created_at: z.iso.datetime(),
        expires_at: z.iso.datetime(),
    })
    .strict();

export const invitationsResponseSchema = z.object({ items: z.array(invitationSchema) }).strict();

const LOGIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const invitationAcceptRequestSchema = z
    .object({ token: z.string().regex(LOGIN_TOKEN_PATTERN) })
    .strict();

export const invitationAcceptedSchema = z
    .object({ status: z.literal("joined"), org_id: idSchema("org") })
    .strict();
