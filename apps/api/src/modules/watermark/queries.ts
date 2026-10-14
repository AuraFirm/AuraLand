import { taskSpecSchema } from "@aura/contracts/tasks";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";

// SQL for delivery watermarks, run as `aura_worker` for a node whose signature was verified. Both
// functions are SECURITY DEFINER (migration 0031): the worker has no table access to deliveries.

const inputSchema = z.object({
    delivery_id: z.string(),
    task_org_id: z.string(),
    bundle_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bundle_bytes: z.coerce.number().int(),
    spec: taskSpecSchema,
    tag: z.coerce.number().int(),
});
export type WatermarkInput = z.infer<typeof inputSchema>;

// What a node needs for one ordered version of a pending delivery; null when there is nothing to do.
export async function watermarkJobInput(
    tx: Transaction,
    deliveryId: string,
    versionId: string,
): Promise<WatermarkInput | null> {
    const rows = await tx`select watermark_job_input(${deliveryId}, ${versionId}) as input`;
    const input = z.object({ input: z.unknown() }).parse(rows[0]).input;
    return input === null ? null : inputSchema.parse(input);
}

export type RecordOutcome = "recorded" | "already" | "gone";

export async function recordDeliveryBundle(
    tx: Transaction,
    input: {
        deliveryId: string;
        versionId: string;
        sourceSha256Hex: string;
        sha256Hex: string;
        bytes: number;
        answers: boolean;
        solutions: boolean;
        checked: boolean;
        nodeId: string;
        nowMs: number;
    },
): Promise<RecordOutcome> {
    const rows = await tx`select record_delivery_bundle(${input.deliveryId}, ${input.versionId},
        ${Buffer.from(input.sourceSha256Hex, "hex")}, ${Buffer.from(input.sha256Hex, "hex")}, ${input.bytes},
        ${input.answers}, ${input.solutions}, ${input.checked}, ${input.nodeId}, ${new Date(input.nowMs)}) as outcome`;
    return z.object({ outcome: z.enum(["recorded", "already", "gone"]) }).parse(rows[0]).outcome;
}
