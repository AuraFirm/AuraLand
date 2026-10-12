import { assert } from "@aura/contracts/assert";
import { encodeId } from "@aura/contracts/ids";
import { ORDER_ITEMS_MAX } from "@aura/contracts/limits";
import { taskSpecSchema } from "@aura/contracts/tasks";
import { z } from "zod";

// Pure rules of delivery building: no I/O, no clock, no randomness. The same input always gives the
// same manifest text, so the golden test and the customer's verification script can rely on it.

const MANIFEST_VERSION = 1;
const CANARY_HEX_CHARS = 16;

export const buildInputSchema = z.object({
    delivery_id: z.uuid(),
    order_id: z.uuid(),
    customer_org_id: z.uuid(),
    watermark_id: z.string().regex(/^[0-9a-f]{32}$/),
    created_at: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }),
    licence_terms: z.string().min(1),
    expected_item_count: z.number().int().min(1).max(ORDER_ITEMS_MAX),
    items: z
        .array(
            z.object({
                task_version_id: z.uuid(),
                task_id: z.uuid(),
                seq: z.number().int().min(1),
                spec: taskSpecSchema,
                statement: z.string().min(1),
                bundle_sha256: z.string().regex(/^[0-9a-f]{64}$/),
                bundle_bytes: z.number().int().min(1),
                waived: z.boolean(),
            }),
        )
        .max(ORDER_ITEMS_MAX),
});
export type BuildInput = z.infer<typeof buildInputSchema>;

// A short per-delivery, per-version string that goes into the statement. If a statement leaks, the
// canary says which delivery it came from. It is not a secret and does not need to be: it only
// has to be unique per delivery and version and impossible to guess for another delivery.
export function deliveryCanary(
    watermarkId: string,
    versionId: string,
    sha256Hex: Sha256Hex,
): string {
    const digest = sha256Hex(`${watermarkId}:${versionId}`);
    return `ref-${digest.slice(0, CANARY_HEX_CHARS)}`;
}

// Hashing is passed in so this file stays free of I/O and library imports.
export type Sha256Hex = (text: string) => string;

const isoTime = (text: string) => new Date(text).toISOString();

// The manifest, as the exact text that is stored and hashed. Keys are in a fixed order on purpose.
export function buildManifest(
    input: BuildInput,
    sha256Hex: Sha256Hex,
): { text: string; sha256Hex: string } {
    assert(
        input.items.length === input.expected_item_count,
        "every ordered version is still released",
    );
    assert(input.items.length >= 1, "a delivery has at least one version");
    const items = input.items.map((item) => ({
        task_version_id: encodeId("tsv", item.task_version_id),
        task_id: encodeId("tsk", item.task_id),
        seq: item.seq,
        title: item.spec.title,
        spec: item.spec,
        statement: `${item.statement}\n\n---\nDelivery reference: ${deliveryCanary(input.watermark_id, item.task_version_id, sha256Hex)}`,
        bundle: { sha256: item.bundle_sha256, bytes: item.bundle_bytes },
        // Honest status: validation needs the sandbox, which does not exist yet (cutlist F32).
        validation: item.waived ? "waived by a reviewer; not performed" : "not performed",
    }));
    const text = JSON.stringify({
        manifest_version: MANIFEST_VERSION,
        delivery_id: encodeId("dlv", input.delivery_id),
        order_id: encodeId("ord", input.order_id),
        customer_org_id: encodeId("org", input.customer_org_id),
        watermark_id: input.watermark_id,
        created_at: isoTime(input.created_at),
        expires_at: isoTime(input.expires_at),
        licence_terms: input.licence_terms,
        items,
    });
    return { text, sha256Hex: sha256Hex(text) };
}

export type DeliveryState = "pending" | "ready" | "revoked";
export type DeliveryStatus = DeliveryState | "expired";

// What a customer is told. Expiry is derived from the clock, so nothing has to write at expiry time.
export function deliveryStatus(
    state: DeliveryState,
    expiresAtMs: number,
    nowMs: number,
): DeliveryStatus {
    assert(Number.isFinite(expiresAtMs) && Number.isFinite(nowMs), "times are finite numbers");
    if (state === "ready" && expiresAtMs <= nowMs) return "expired";
    return state;
}

// The part of a stored manifest the portal shows; the manifest itself is the source of truth.
export const manifestSummarySchema = z.object({
    items: z.array(
        z.object({
            task_version_id: z.string(),
            title: z.string(),
            bundle: z.object({ sha256: z.string(), bytes: z.number() }),
            validation: z.string(),
        }),
    ),
});
