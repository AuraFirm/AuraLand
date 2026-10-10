import { z } from "zod";
import { orgNameSchema, orgRoleSchema, orgSlugSchema } from "../identity.ts";
import { idSchema } from "../ids.ts";

// Request and response shapes for organizations and their members.

// Personal spaces are made for everyone at sign-up; people create these kinds.
export const CREATABLE_ORG_KINDS = ["university", "company", "ai_lab", "community"] as const;
export const ORG_KINDS = ["personal", ...CREATABLE_ORG_KINDS, "platform"] as const;
export const DATA_REGIONS = ["eu", "us", "ap"] as const;

export const orgCreateRequestSchema = z
    .object({
        name: orgNameSchema,
        slug: orgSlugSchema,
        kind: z.enum(CREATABLE_ORG_KINDS),
        data_region: z.enum(DATA_REGIONS).default("eu"),
    })
    .strict();

export const orgUpdateRequestSchema = z.object({ name: orgNameSchema }).strict();

export const orgSchema = z
    .object({
        id: idSchema("org"),
        kind: z.enum(ORG_KINDS),
        slug: z.string(),
        name: z.string(),
        verification_state: z.enum(["unverified", "verified"]),
        data_region: z.enum(DATA_REGIONS),
        created_at: z.iso.datetime(),
        // The caller's own role in this organization.
        role: orgRoleSchema,
    })
    .strict();
export type OrgItem = z.infer<typeof orgSchema>;

export const orgsResponseSchema = z.object({ items: z.array(orgSchema) }).strict();

export const memberSchema = z
    .object({
        user_id: idSchema("usr"),
        handle: z.string().nullable(),
        display_name: z.string().nullable(),
        role: orgRoleSchema,
        joined_at: z.iso.datetime(),
    })
    .strict();

export const membersResponseSchema = z.object({ items: z.array(memberSchema) }).strict();

export const memberRoleRequestSchema = z.object({ role: orgRoleSchema }).strict();
