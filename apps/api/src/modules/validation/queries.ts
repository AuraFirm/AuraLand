import { taskSpecSchema } from "@aura/contracts/tasks";
import type { ValidationCheck, ValidationResult } from "@aura/contracts/validation";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for validating task versions, run as `aura_worker` for a node whose signature was verified.
// Reports are written only by settle_validation (migration 0026), never by a plain insert.

const workSchema = z.object({
    id: z.string(),
    org_id: z.string(),
    state: z.string(),
    spec: taskSpecSchema.nullable(),
    bundle_bytes: z.coerce.number().int().nullable(),
    bundle_sha256: z.instanceof(Uint8Array).nullable(),
});
export type ValidationWork = z.infer<typeof workSchema>;

// The version behind a validation job. It is not locked here: the worker role may only read these
// columns, and settle_validation takes the row lock itself when it settles.
export async function readValidationWork(
    tx: Transaction,
    versionId: string,
): Promise<ValidationWork | null> {
    const rows = await tx`
        select id, org_id, state, spec, bundle_bytes, bundle_sha256
        from task_versions where id = ${versionId}`;
    return rows[0] === undefined ? null : workSchema.parse(rows[0]);
}

// Stores the report and moves the version, both or neither. Null when the version is no longer being
// validated (a late or duplicate result).
export async function settleValidation(
    tx: Transaction,
    input: {
        versionId: string;
        nodeId: string;
        checks: readonly ValidationCheck[];
        observations: ValidationResult;
        nowMs: number;
    },
): Promise<string | null> {
    const rows = await tx`
        select settle_validation(${input.versionId}, ${input.nodeId}, ${tx.json([...input.checks])},
            ${tx.json(input.observations)}, ${new Date(input.nowMs)}) as report`;
    const report = z.object({ report: z.string().nullable() }).parse(rows[0]).report;
    return report;
}
