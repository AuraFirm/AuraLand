import { createHash } from "node:crypto";
import { encodeId } from "@aura/contracts/ids";
import { appendAudit } from "@aura/db/audit";
import type { Transaction } from "@aura/db/context";
import { z } from "zod";
import type { Clock } from "../../platform/clock.ts";
import { buildInputSchema, buildManifest } from "./rules.ts";

// The delivery.build job. It runs on the worker as `aura_worker` and reaches data only through the two
// functions of migration 0021. It never opens an archive: the manifest names the bundles by hash and
// the customer downloads the original, already verified bytes.

// What the job needs from the worker; the worker's own context has at least this shape.
export interface DeliveryBuildContext {
    readonly clock: Clock;
    readonly inTransaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
}

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export const DELIVERY_BUILD_KIND = "delivery.build";

const payloadSchema = z.object({ delivery_id: z.uuid() }).strict();
const completionSchema = z.enum(["ready", "already_ready", "revoked"]);

export async function buildDelivery(payload: unknown, context: DeliveryBuildContext) {
    const { delivery_id: deliveryId } = payloadSchema.parse(payload);
    const nowMs = context.clock.nowUnixMs();
    const rows = await context.inTransaction(
        (tx) => tx`select delivery_build_input(${deliveryId}) as input`,
    );
    const found = z.object({ input: z.unknown() }).parse(rows[0]).input;
    // A delivery that is no longer pending (revoked, or built by an earlier attempt) needs nothing.
    if (found === null) return { outcome: "skipped" as const };
    const input = buildInputSchema.parse(found);
    const manifest = buildManifest(input, sha256Hex);
    return context.inTransaction(async (tx) => {
        const done =
            await tx`select complete_delivery(${deliveryId}, ${manifest.text}, ${new Date(nowMs)}) as outcome`;
        const outcome = completionSchema.parse(
            z.object({ outcome: z.string() }).parse(done[0]).outcome,
        );
        if (outcome === "ready") {
            await appendAudit(tx, {
                actorKind: "worker",
                actorUserId: null,
                orgId: input.customer_org_id,
                action: "delivery.built",
                target: encodeId("dlv", deliveryId),
                detail: { items: input.items.length, manifest_sha256: manifest.sha256Hex },
            });
        }
        return { outcome, manifest_sha256: manifest.sha256Hex };
    });
}
