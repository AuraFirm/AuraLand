import { z } from "zod";

// Request and response shapes for the OAuth routes (GitHub, Google).

export const OAUTH_PROVIDERS = ["github", "google"] as const;
export const oauthProviderSchema = z.enum(OAUTH_PROVIDERS);
export type OAuthProviderName = z.infer<typeof oauthProviderSchema>;

// "login" signs a person in or creates their account; "link" attaches the provider to the person
// who is already signed in.
export const oauthStartRequestSchema = z
    .object({ purpose: z.enum(["login", "link"]).default("login") })
    .strict();

export const oauthStartResponseSchema = z.object({ authorization_url: z.url() }).strict();

// Where the callback sends the browser. Only these fixed words appear in the address.
export const OAUTH_RESULTS = ["signed_in", "linked", "failed"] as const;
export const OAUTH_FAILURE_REASONS = [
    "denied",
    "invalid",
    "email_unverified",
    "account_exists",
    "identity_taken",
    "suspended",
    "unavailable",
] as const;
export type OAuthFailureReason = (typeof OAUTH_FAILURE_REASONS)[number];

export const identitySchema = z
    .object({
        provider: oauthProviderSchema,
        email: z.string().nullable(),
        created_at: z.iso.datetime(),
        last_login_at: z.iso.datetime().nullable(),
    })
    .strict();

export const identitiesResponseSchema = z.object({ items: z.array(identitySchema) }).strict();
