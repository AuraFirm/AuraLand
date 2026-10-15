"use client";

import { orgSchema } from "@aura/contracts/api/orgs";
import { useCallback } from "react";
import { apiGet } from "../lib/api.ts";
import { useLoad } from "../lib/use-load.ts";
import { OrgPlan } from "./org-plan.tsx";
import { OrgScim } from "./org-scim.tsx";
import { OrgSso } from "./org-sso.tsx";
import { OrgWebhooks } from "./org-webhooks.tsx";
import { Notice } from "./section.tsx";

// The administrator's page for an organization: plan and usage, single sign-on, provisioning and webhooks. Only owners and
// administrators see it; the server decides again on every call, so hiding it here is a courtesy, not the control.
export function OrgAdminConsole({ orgId }: { orgId: string }) {
    const load = useCallback(() => apiGet(`/orgs/${orgId}`, orgSchema), [orgId]);
    const { data, error } = useLoad(load);
    if (error !== "") {
        return (
            <>
                <h1 className="text-2xl font-semibold">Admin console</h1>
                <Notice text={error} bad />
            </>
        );
    }
    if (data === null) return <h1 className="text-2xl font-semibold">Admin console</h1>;
    if (data.role !== "owner" && data.role !== "admin") {
        return (
            <>
                <h1 className="text-2xl font-semibold">Admin console</h1>
                <Notice text="Only owners and administrators can open the admin console." bad />
                <a className="text-accent underline" href={`/orgs/${orgId}`}>
                    Back to {data.name}
                </a>
            </>
        );
    }
    return (
        <>
            <h1 className="text-2xl font-semibold">Admin console: {data.name}</h1>
            <OrgPlan org={data} />
            <OrgSso org={data} />
            <OrgScim org={data} />
            <OrgWebhooks org={data} />
            <a className="text-accent underline" href="/developers">
                Developer documentation
            </a>
            <a className="text-accent underline" href={`/orgs/${orgId}`}>
                Back to {data.name}
            </a>
        </>
    );
}
