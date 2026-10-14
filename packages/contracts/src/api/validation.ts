import { z } from "zod";
import { idSchema } from "../ids.ts";
import { validationCheckSchema } from "../validation.ts";

// The latest validation report of a task version, as people who work on the task see it. The node's raw
// observations stay in the database; what is shown is the conclusion and the evidence behind it.
export const validationReportSchema = z
    .object({
        id: idSchema("vrp"),
        task_version_id: idSchema("tsv"),
        // Which kind of machine produced it. Only a 'production' report may be called plain "validated".
        attestation: z.enum(["development", "production"]),
        passed: z.boolean(),
        score: z.number().min(0).max(100).nullable(),
        score_version: z.number().int().min(1).nullable(),
        checks: z.array(validationCheckSchema).max(100),
        created_at: z.iso.datetime(),
    })
    .strict();
export type ValidationReport = z.infer<typeof validationReportSchema>;

export const validationReportResponseSchema = z
    .object({ report: validationReportSchema.nullable() })
    .strict();
