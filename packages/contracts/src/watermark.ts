import { z } from "zod";
import { idSchema } from "./ids.ts";
import { BUNDLE_BYTES_MAX } from "./limits.ts";
import { taskSpecSchema } from "./tasks.ts";
import { validationResultSchema } from "./validation.ts";

// Writing a delivery's watermark into a bundle (Stage 4C, ADR 0030). A judge node rewrites the bundle in
// a box and reports what it did and saw; the control plane decides whether that is good enough to deliver.

export const watermarkJobSchema = z
    .object({
        job_id: idSchema("job"),
        lease_epoch: z.number().int().min(1),
        lease_ttl_s: z.number().int().min(1),
        kind: z.literal("delivery.watermark"),
        task: z
            .object({
                bundle: z
                    .object({
                        sha256: z.string().regex(/^[0-9a-f]{64}$/),
                        bytes: z.number().int().min(1),
                    })
                    .strict(),
                spec: taskSpecSchema,
                // The 32-bit tag to write, top bit set. It is derived by the database from a secret
                // the node never sees, so it identifies a delivery without revealing which.
                tag: z
                    .number()
                    .int()
                    .min(2 ** 31)
                    .max(2 ** 32 - 1),
            })
            .strict(),
    })
    .strict();

export const watermarkLeaseResponseSchema = z
    .object({ job: watermarkJobSchema.nullable() })
    .strict();

// The node asks where to put the rewritten bundle, naming its size; the answer is a short-lived URL for
// exactly one object of exactly that size.
export const watermarkUploadRequestSchema = z
    .object({
        lease_epoch: z.number().int().min(1),
        bytes: z.number().int().min(1).max(BUNDLE_BYTES_MAX),
    })
    .strict();
export const watermarkUploadResponseSchema = z
    .object({ upload_id: z.string().min(1).max(512), url: z.string().url().max(4096) })
    .strict();

// The node's report. "unchanged": the bundle has no safe place for a mark, so it is delivered as it is.
// "rewritten": the new bundle was uploaded; `observations` holds the harness run on the original and on
// the rewritten bundle (null for tasks the harness cannot run, where only a solution's comment changed).
export const watermarkResultSchema = z.discriminatedUnion("outcome", [
    z.object({ outcome: z.literal("unchanged") }).strict(),
    z
        .object({
            outcome: z.literal("rewritten"),
            upload_id: z.string().min(1).max(512),
            answers: z.boolean(),
            solutions: z.boolean(),
            observations: z
                .object({ original: validationResultSchema, rewritten: validationResultSchema })
                .strict()
                .nullable(),
        })
        .strict(),
]);
export type WatermarkResult = z.infer<typeof watermarkResultSchema>;

export const watermarkCompleteRequestSchema = z
    .object({ lease_epoch: z.number().int().min(1), result: watermarkResultSchema })
    .strict();
