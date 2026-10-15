import { PLAN_KEYS } from "@aura/contracts/api/billing";
import { decodeId, idSchema } from "@aura/contracts/ids";
import { z } from "zod";

// What we take from a payment provider's event. The provider adds fields over time, so this is the one place the boundary is
// deliberately not `.strict()`: we read the few fields we use and ignore the rest. Everything we use is validated here, and an
// event that does not carry them is recorded as ignored, never guessed at.

const eventSchema = z.object({
    id: z.string().min(1).max(255),
    type: z.string().min(1).max(100),
    created: z.number().int().min(0),
    data: z.object({
        object: z.object({
            client_reference_id: z.string().max(100).nullish(),
            customer: z.string().min(1).max(255).nullish(),
            metadata: z.record(z.string(), z.string().max(255)).nullish(),
        }),
    }),
});
export type ProviderEvent = z.infer<typeof eventSchema>;

export function parseProviderEvent(text: string): ProviderEvent | null {
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return null;
    }
    const parsed = eventSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
}

export interface PlanChange {
    readonly org: string | null; // an organization id (uuid), or null when the event does not name one we can read
    readonly plan: string | null;
    readonly billingRef: string | null;
}

// Only two event types change a plan. A checkout that completed puts the organization named by `client_reference_id` on the plan
// named in the session's metadata (only a paid plan the provider sells); a subscription that ended puts the organization named in
// its metadata back on the free plan. Anything else changes nothing.
export function planChangeOf(event: ProviderEvent): PlanChange {
    const object = event.data.object;
    if (event.type === "checkout.session.completed") {
        const plan = object.metadata?.["plan"] ?? null;
        const sold = plan !== null && plan !== "free" && PLAN_KEYS.some((key) => key === plan);
        return {
            org: orgFrom(object.client_reference_id),
            plan: sold ? plan : null,
            billingRef: object.customer ?? null,
        };
    }
    if (event.type === "customer.subscription.deleted") {
        return { org: orgFrom(object.metadata?.["org_id"]), plan: "free", billingRef: null };
    }
    return { org: null, plan: null, billingRef: null };
}

function orgFrom(publicId: string | null | undefined): string | null {
    const parsed = idSchema("org").safeParse(publicId);
    return parsed.success ? decodeId("org", parsed.data) : null;
}
