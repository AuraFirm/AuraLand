import { z } from "zod";
import {
    assuranceLevelSchema,
    credentialKindSchema,
    verifyOutcomeSchema,
    visibilitySchema,
} from "../credentials.ts";
import { idSchema } from "../ids.ts";
import { SHARE_LINK_DAYS_DEFAULT, SHARE_LINK_DAYS_MAX } from "../limits.ts";

// What the public verification endpoint says about a credential (Stage 7, slice 4). Everything but `outcome` and
// `status_known` is present only when the signature checked out, and is read from the signed JWT, never from our
// database. `jwt` lets a verifier check it again with software of their own.
export const verifyResponseSchema = z
    .object({
        id: z.string(),
        outcome: verifyOutcomeSchema,
        // False when the revocation list could not be read or checked: the credential's signature is fine, but
        // whether it was revoked is not known. The page says so.
        status_known: z.boolean(),
        reason: z.string().optional(),
        name: z.string().optional(),
        issuer: z.string().optional(),
        description: z.string().optional(),
        assurance_level: assuranceLevelSchema.optional(),
        environment: z.enum(["development", "production"]).optional(),
        issued_at: z.iso.datetime().optional(),
        expires_at: z.iso.datetime().optional(),
        jwt: z.string().optional(),
    })
    .strict();
export type VerifyResponse = z.infer<typeof verifyResponseSchema>;

// The holder's side (Stage 7, slice 6): their credentials, who may see each, and the links they have made.
export const myCredentialSchema = z
    .object({
        id: idSchema("crd"),
        kind: credentialKindSchema,
        name: z.string(),
        assurance_level: assuranceLevelSchema,
        issued_at: z.iso.datetime(),
        expires_at: z.iso.datetime().nullable(),
        revoked: z.boolean(),
        visibility: visibilitySchema,
        shares: z.array(
            z
                .object({ id: idSchema("shr"), expires_at: z.iso.datetime(), revoked: z.boolean() })
                .strict(),
        ),
    })
    .strict();
export const myCredentialsResponseSchema = z
    .object({ credentials: z.array(myCredentialSchema) })
    .strict();
export const setVisibilityRequestSchema = z.object({ visibility: visibilitySchema }).strict();
export const createShareRequestSchema = z
    .object({
        days: z.number().int().min(1).max(SHARE_LINK_DAYS_MAX).default(SHARE_LINK_DAYS_DEFAULT),
    })
    .strict();
// The link is shown once: only a hash of its secret is kept.
export const createShareResponseSchema = z
    .object({ share_id: idSchema("shr"), url: z.string(), expires_at: z.iso.datetime() })
    .strict();
