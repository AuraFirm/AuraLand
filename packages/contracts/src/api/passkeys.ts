import { z } from "zod";
import { displayNameSchema } from "../identity.ts";
import { idSchema } from "../ids.ts";

// Request and response shapes for passkey routes. The browser library sends credentials as JSON
// with base64url strings; each field is size-capped here, before the verifier sees any of it.

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const base64url = (lengthMax: number) => z.string().min(1).max(lengthMax).regex(BASE64URL);
const CREDENTIAL_ID_TEXT_MAX = 1400; // 1023 bytes as base64url, with room to spare
const CLIENT_DATA_TEXT_MAX = 4096;
const ATTESTATION_TEXT_MAX = 16_384;
const SIGNATURE_TEXT_MAX = 1024;
const TRANSPORTS_MAX = 8;

const uuid = z.uuid();
const attachment = z.enum(["platform", "cross-platform"]);
const extensionResults = z
    .record(z.string(), z.json())
    .refine((value) => JSON.stringify(value).length <= 4096, "extension results are too large");

export const registrationCredentialSchema = z
    .object({
        id: base64url(CREDENTIAL_ID_TEXT_MAX),
        rawId: base64url(CREDENTIAL_ID_TEXT_MAX),
        type: z.literal("public-key"),
        authenticatorAttachment: attachment.optional(),
        clientExtensionResults: extensionResults,
        response: z
            .object({
                clientDataJSON: base64url(CLIENT_DATA_TEXT_MAX),
                attestationObject: base64url(ATTESTATION_TEXT_MAX),
                authenticatorData: base64url(ATTESTATION_TEXT_MAX).optional(),
                transports: z.array(z.string().max(32)).max(TRANSPORTS_MAX).optional(),
                publicKeyAlgorithm: z.number().int().optional(),
                publicKey: base64url(ATTESTATION_TEXT_MAX).optional(),
            })
            .strict(),
    })
    .strict();

export const authenticationCredentialSchema = z
    .object({
        id: base64url(CREDENTIAL_ID_TEXT_MAX),
        rawId: base64url(CREDENTIAL_ID_TEXT_MAX),
        type: z.literal("public-key"),
        authenticatorAttachment: attachment.optional(),
        clientExtensionResults: extensionResults,
        response: z
            .object({
                clientDataJSON: base64url(CLIENT_DATA_TEXT_MAX),
                authenticatorData: base64url(ATTESTATION_TEXT_MAX),
                signature: base64url(SIGNATURE_TEXT_MAX),
                userHandle: base64url(CREDENTIAL_ID_TEXT_MAX).optional(),
            })
            .strict(),
    })
    .strict();

export const passkeyOptionsResponseSchema = z
    .object({
        // Sent back with the browser's answer so the server can find and spend the challenge.
        challenge_id: uuid,
        // Produced by the verification library for navigator.credentials; passed through as is.
        options: z.record(z.string(), z.json()),
    })
    .strict();

export const passkeyRegisterRequestSchema = z
    .object({
        challenge_id: uuid,
        name: displayNameSchema.optional(),
        credential: registrationCredentialSchema,
    })
    .strict();

export const passkeyLoginRequestSchema = z
    .object({ challenge_id: uuid, credential: authenticationCredentialSchema })
    .strict();

export const passkeyLoginResponseSchema = z.object({ status: z.literal("signed_in") }).strict();

export const passkeyRenameRequestSchema = z.object({ name: displayNameSchema }).strict();

export const passkeySchema = z
    .object({
        id: idSchema("pky"),
        name: z.string(),
        created_at: z.iso.datetime(),
        last_used_at: z.iso.datetime().nullable(),
        transports: z.array(z.string()),
        device_type: z.enum(["singleDevice", "multiDevice"]),
        backed_up: z.boolean(),
    })
    .strict();
export type PasskeyItem = z.infer<typeof passkeySchema>;

export const passkeysResponseSchema = z.object({ items: z.array(passkeySchema) }).strict();

export const passkeyAddedResponseSchema = z
    .object({ id: idSchema("pky"), name: z.string() })
    .strict();
