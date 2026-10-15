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

export interface PaymentProvider {
    createCheckoutSession(request: CheckoutRequest): Promise<{ sessionId: string; url: string }>;
    createPortalSession(request: {
        billingRef: string;
        returnUrl: string;
    }): Promise<{ url: string }>;
}

// Records what it was asked, so tests can see exactly what a route sent to the provider.
export interface FakePaymentProvider extends PaymentProvider {
    readonly checkouts: CheckoutRequest[];
    readonly portals: { billingRef: string; returnUrl: string }[];
}

export function createFakePaymentProvider(): FakePaymentProvider {
    const checkouts: CheckoutRequest[] = [];
    const portals: { billingRef: string; returnUrl: string }[] = [];
    return {
        checkouts,
        portals,
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
