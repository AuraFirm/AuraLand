// Billing sits behind a port so a payment provider can replace the manual process without touching the
// order routes. Today the only adapter is manual: staff issue invoices elsewhere, type the reference
// into the order and record the payment, and the adapter reports exactly that. Card data never enters
// this system (kit: out of scope). A provider adapter arrives with the legal entity (decision D1).

export type PaymentStatus = "unpaid" | "paid";

export interface BillingFacts {
    readonly paidAtMs: number | null;
    readonly invoiceReference: string | null;
}

export interface BillingPort {
    paymentStatus(facts: BillingFacts): PaymentStatus;
}

export const manualBilling: BillingPort = {
    paymentStatus: (facts) => (facts.paidAtMs === null ? "unpaid" : "paid"),
};
