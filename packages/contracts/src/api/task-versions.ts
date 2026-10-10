import { z } from "zod";
import { idSchema } from "../ids.ts";
import { BUNDLE_BYTES_MAX } from "../limits.ts";
import {
    reviewOutcomeSchema,
    statementSchema,
    taskSpecSchema,
    versionStateSchema,
} from "../tasks.ts";

// Request and response shapes for task versions and bundle uploads. Responses are allowlists: a
// version shows its spec (test ids and points only), its statement and its bundle's size and hash,
// never a storage key, an upload id or any file content.

export const versionCreateRequestSchema = z.object({}).strict();

export const versionUpdateRequestSchema = z
    .object({ statement: statementSchema.optional(), spec: taskSpecSchema.optional() })
    .strict()
    .refine((body) => body.statement !== undefined || body.spec !== undefined, "nothing to change");

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "lowercase SHA-256 in hex");

export const versionSchema = z
    .object({
        id: idSchema("tsv"),
        task_id: idSchema("tsk"),
        seq: z.number().int().min(1),
        state: versionStateSchema,
        spec: taskSpecSchema.nullable(),
        statement: z.string().nullable(),
        // The statement rendered to safe HTML by the API (renderMarkdownSafe). Only the single-version
        // read fills it; other answers carry null so lists stay cheap.
        statement_html: z.string().nullable(),
        bundle: z
            .object({ bytes: z.number().int().min(1), sha256: sha256HexSchema })
            .strict()
            .nullable(),
        // True when the release skipped sandbox validation on a reviewer's recorded waiver.
        waived: z.boolean(),
        created_by: idSchema("usr"),
        created_at: z.iso.datetime(),
        updated_at: z.iso.datetime(),
        released_at: z.iso.datetime().nullable(),
    })
    .strict();
export type VersionItem = z.infer<typeof versionSchema>;

export const versionsResponseSchema = z.object({ items: z.array(versionSchema) }).strict();

export const uploadStartRequestSchema = z
    .object({ bytes: z.number().int().min(1).max(BUNDLE_BYTES_MAX), sha256: sha256HexSchema })
    .strict();

// Everything the browser needs to upload the bundle straight to storage: PUT part `part_number`
// (exactly `bytes` bytes) to its `url`, in any order, then call finalize.
export const uploadPlanSchema = z
    .object({
        upload_id: idSchema("bup"),
        expires_at: z.iso.datetime(),
        parts: z
            .array(
                z
                    .object({
                        part_number: z.number().int().min(1),
                        bytes: z.number().int().min(1),
                        url: z.url(),
                    })
                    .strict(),
            )
            .min(1),
    })
    .strict();

export const finalizeRequestSchema = z.object({ upload_id: idSchema("bup") }).strict();

export const reviewRequestSchema = z
    .object({
        outcome: reviewOutcomeSchema,
        comment: z.string().trim().min(1).max(4000).optional(),
    })
    .strict();

// Releasing without sandbox validation is a recorded decision: the reason goes in the audit log.
export const releaseRequestSchema = z
    .object({ waiver_reason: z.string().trim().min(10).max(1000).optional() })
    .strict();
