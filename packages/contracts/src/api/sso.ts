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
        enforced: z.boolean(),
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

// Signing in. `start` takes the address the person types and answers with where to send the browser.
export const ssoStartRequestSchema = z.object({ email: z.email().max(254) }).strict();
export const ssoStartResponseSchema = z.object({ authorization_url: z.url() }).strict();
export const ssoEnforcementRequestSchema = z.object({ enforced: z.boolean() }).strict();

// The callback sends the browser to /auth/done with one of these words, nothing else.
export const SSO_FAILURE_REASONS = [
    "denied",
    "invalid",
    "email_unverified",
    "wrong_domain",
    "suspended",
    "plan_full",
    "unavailable",
] as const;
export type SsoFailureReason = (typeof SSO_FAILURE_REASONS)[number];

// SCIM bearer tokens: the token itself is shown once, when it is made.
export const scimTokenSchema = z
    .object({
        id: idSchema("sct"),
        created_at: z.iso.datetime(),
        last_used_at: z.iso.datetime().nullable(),
        revoked: z.boolean(),
    })
    .strict();
export const scimTokenCreatedSchema = z
    .object({ token: z.string().min(20).max(100), scim_token: scimTokenSchema, base_url: z.url() })
    .strict();
export const scimTokensResponseSchema = z.object({ tokens: z.array(scimTokenSchema) }).strict();
