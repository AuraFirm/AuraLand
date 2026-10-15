import { z } from "zod";
import { assuranceLevelSchema, verifyOutcomeSchema } from "../credentials.ts";

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
