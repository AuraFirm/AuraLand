"use client";

import {
    type Entitlements,
    entitlementsSchema,
    sessionUrlSchema,
    usageResponseSchema,
} from "@aura/contracts/api/billing";
import type { OrgItem } from "@aura/contracts/api/orgs";
import { useCallback, useState } from "react";
import { apiGet, apiSend, messageOf } from "../lib/api.ts";
import { withStepUp } from "../lib/passkeys.ts";
import { button, buttonQuiet } from "../lib/styles.ts";
import { useLoad } from "../lib/use-load.ts";
import { Notice, Section } from "./section.tsx";

type Usage = { env_runs: number; employer_reports: number };

// The organization's plan, what it includes, and this month's use. Buying and managing a subscription go to the payment provider's
// own pages; nothing about a card is ever entered here.
export function OrgPlan({ org }: { org: OrgItem }) {
    const loadPlan = useCallback(
        () => apiGet(`/orgs/${org.id}/plan`, entitlementsSchema),
        [org.id],
    );
    const loadUsage = useCallback(
        () => apiGet(`/orgs/${org.id}/usage`, usageResponseSchema),
        [org.id],
    );
    const plan = useLoad(loadPlan);
    const usage = useLoad(loadUsage);
    const [message, setMessage] = useState("");

    const go = async (path: string, body?: unknown) => {
        try {
            const session = await withStepUp(() =>
                apiSend(path, sessionUrlSchema, {
                    method: "POST",
                    ...(body === undefined ? {} : { body }),
                }),
            );
            window.location.assign(session.url);
        } catch (failure) {
            setMessage(messageOf(failure));
        }
    };

    return (
        <Section id="plan" title="Plan and usage">
            {plan.error !== "" && <Notice text={plan.error} bad />}
            {plan.data !== null && <PlanFacts plan={plan.data} usage={usage.data} />}
            <div className="flex flex-wrap gap-2">
                {plan.data?.plan === "free" && (
                    <button
                        type="button"
                        className={button}
                        onClick={() => go(`/orgs/${org.id}/billing/checkout`, { plan: "team" })}
                    >
                        Choose the Team plan
                    </button>
                )}
                <button
                    type="button"
                    className={buttonQuiet}
                    onClick={() => go(`/orgs/${org.id}/billing/portal`)}
                >
                    Manage billing
                </button>
            </div>
            {message !== "" && <Notice text={message} bad />}
        </Section>
    );
}

function PlanFacts({ plan, usage }: { plan: Entitlements; usage: Usage | null }) {
    return (
        <dl className="mb-4 grid grid-cols-2 gap-2">
            <dt>Plan</dt>
            <dd data-testid="plan-name">{plan.name}</dd>
            <dt>Members up to</dt>
            <dd>{plan.members_max}</dd>
            <dt>Environment runs a month</dt>
            <dd>{usage === null ? "…" : `${usage.env_runs} of ${plan.env_runs_per_month}`}</dd>
            <dt>Employer reports this month</dt>
            <dd>{usage === null ? "…" : usage.employer_reports}</dd>
            <dt>Single sign-on</dt>
            <dd>{plan.sso ? "Included" : "Not included"}</dd>
            <dt>Provisioning (SCIM)</dt>
            <dd>{plan.scim ? "Included" : "Not included"}</dd>
            <dt>Webhook endpoints up to</dt>
            <dd>{plan.webhook_endpoints_max}</dd>
        </dl>
    );
}
