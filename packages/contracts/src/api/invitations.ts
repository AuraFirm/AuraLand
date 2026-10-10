import { z } from "zod";
import { emailSchema } from "../identity.ts";
import { idSchema } from "../ids.ts";

// Request and response shapes for organization invitations.

// Everything but owner: an organization gets a second owner by changing a member's role, which needs
// a fresh passkey check.
export const invitableRoleSchema = z.enum(["admin", "setter", "reviewer", "member"]);
export type InvitableRole = z.infer<typeof invitableRoleSchema>;

export const invitationCreateRequestSchema = z
    .object({ email: emailSchema, role: invitableRoleSchema.default("member") })
    .strict();

export const invitationSchema = z
    .object({
        id: idSchema("inv"),
        email: z.string(),
        role: invitableRoleSchema,
        created_at: z.iso.datetime(),
        expires_at: z.iso.datetime(),
    })
    .strict();

export type InvitationItem = z.infer<typeof invitationSchema>;

export const invitationsResponseSchema = z.object({ items: z.array(invitationSchema) }).strict();

const LOGIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const invitationAcceptRequestSchema = z
    .object({ token: z.string().regex(LOGIN_TOKEN_PATTERN) })
    .strict();

export const invitationAcceptedSchema = z
    .object({ status: z.literal("joined"), org_id: idSchema("org") })
    .strict();
