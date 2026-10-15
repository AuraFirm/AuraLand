// Goal: only the two event types we understand change a plan, only for an organization the event names correctly, and only to a
// plan the provider sells; everything else changes nothing.
import { describe, expect, it } from "vitest";
import { parseProviderEvent, planChangeOf } from "./provider-events.ts";

const ORG = "018f0000-0000-7000-8000-000000000011";
const event = (type: string, object: Record<string, unknown>) =>
    JSON.stringify({
        id: "evt_1",
        type,
        created: 1_800_000_000,
        data: { object },
        extra: "ignored",
    });
const change = (type: string, object: Record<string, unknown>) => {
    const parsed = parseProviderEvent(event(type, object));
    if (parsed === null) throw new Error("did not parse");
    return planChangeOf(parsed);
};

describe("planChangeOf", () => {
    it("puts the organization on the plan a completed checkout names", () => {
        expect(
            change("checkout.session.completed", {
                client_reference_id: `org_${ORG}`,
                customer: "cus_1",
                metadata: { plan: "team" },
            }),
        ).toEqual({ org: ORG, plan: "team", billingRef: "cus_1" });
    });

    it("puts the organization back on free when a subscription ends", () => {
        expect(
            change("customer.subscription.deleted", { metadata: { org_id: `org_${ORG}` } }),
        ).toEqual({ org: ORG, plan: "free", billingRef: null });
    });

    it("changes nothing for an unknown plan, the free plan as a purchase, a bad organization or another event", () => {
        const ref = { client_reference_id: `org_${ORG}`, customer: "cus_1" };
        expect(
            change("checkout.session.completed", { ...ref, metadata: { plan: "platinum" } }).plan,
        ).toBeNull();
        expect(
            change("checkout.session.completed", { ...ref, metadata: { plan: "free" } }).plan,
        ).toBeNull();
        expect(change("checkout.session.completed", { ...ref, metadata: {} }).plan).toBeNull();
        expect(
            change("checkout.session.completed", {
                client_reference_id: "not-an-org",
                metadata: { plan: "team" },
            }).org,
        ).toBeNull();
        expect(change("invoice.paid", { ...ref, metadata: { plan: "team" } })).toEqual({
            org: null,
            plan: null,
            billingRef: null,
        });
    });
});

describe("parseProviderEvent", () => {
    it("refuses what is not an event", () => {
        for (const bad of [
            "",
            "nope",
            "[]",
            "{}",
            '{"id":"e","type":"t","created":-1,"data":{"object":{}}}',
        ])
            expect(parseProviderEvent(bad), bad).toBeNull();
    });
});
