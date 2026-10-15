// The payment provider behind a port (Stage 9, slice 3b), so Stripe can replace the fake without touching a route. The only
// adapter today is the fake: it answers with deterministic addresses on a reserved host and moves no money. A Stripe adapter is
// written only when there is an account to run it against (cutlist F77). Card data never enters this system.

export interface CheckoutRequest {
    // The organization's public id; the provider echoes it back in the event (`client_reference_id`) so the webhook can find it.
    readonly orgPublicId: string;
    readonly plan: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
}

import type { UsageLine } from "./reconcile.ts";

export interface PaymentProvider {
    createCheckoutSession(request: CheckoutRequest): Promise<{ sessionId: string; url: string }>;
    createPortalSession(request: {
        billingRef: string;
        returnUrl: string;
    }): Promise<{ url: string }>;
    // Tell the provider what a closed month's usage was. The period names the month, so telling it twice replaces rather than adds.
    reportUsage(period: string, lines: readonly UsageLine[]): Promise<void>;
    // What the provider holds for that month.
    listUsageLines(period: string): Promise<UsageLine[]>;
}

// Records what it was asked, so tests can see exactly what a route sent to the provider.
export interface FakePaymentProvider extends PaymentProvider {
    readonly checkouts: CheckoutRequest[];
    readonly portals: { billingRef: string; returnUrl: string }[];
    // Tests change what the "provider" holds to play a provider that disagrees.
    readonly held: Map<string, UsageLine[]>;
}

export function createFakePaymentProvider(): FakePaymentProvider {
    const checkouts: CheckoutRequest[] = [];
    const portals: { billingRef: string; returnUrl: string }[] = [];
    const held = new Map<string, UsageLine[]>();
    return {
        checkouts,
        portals,
        held,
        reportUsage: async (period, lines) => {
            held.set(period, [...lines]);
        },
        listUsageLines: async (period) => [...(held.get(period) ?? [])],
        createCheckoutSession: async (request) => {
            checkouts.push(request);
            const sessionId = `cs_fake_${checkouts.length}`;
            return { sessionId, url: `https://billing.fake.invalid/checkout/${sessionId}` };
        },
        createPortalSession: async (request) => {
            portals.push(request);
            return { url: `https://billing.fake.invalid/portal/${request.billingRef}` };
        },
    };
}
