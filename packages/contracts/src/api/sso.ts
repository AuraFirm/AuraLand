import { z } from "zod";
import { idSchema } from "../ids.ts";

// Enterprise single sign-on with OpenID Connect (Stage 9, slice 6). A connection is one provider per organization.

export const DOMAIN_PATTERN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const domainSchema = z.string().max(253).regex(DOMAIN_PATTERN);

export const saveSsoConnectionRequestSchema = z
    .object({
        issuer: z.url().max(500),
        client_id: z.string().min(1).max(200),
        client_secret: z.string().min(1).max(400),
    })
    .strict();

export const ssoConnectionSchema = z
    .object({
        org_id: idSchema("org"),
        issuer: z.string(),
        client_id: z.string(),
        updated_at: z.iso.datetime(),
    })
    .strict();

export const addSsoDomainRequestSchema = z.object({ domain: domainSchema }).strict();

// What to publish in DNS to prove control: a TXT record on `txt_name` whose value is exactly `txt_value`.
export const ssoDomainSchema = z
    .object({
        domain: z.string(),
        txt_name: z.string(),
        txt_value: z.string(),
        verified: z.boolean(),
    })
    .strict();
export const ssoDomainsResponseSchema = z.object({ domains: z.array(ssoDomainSchema) }).strict();
