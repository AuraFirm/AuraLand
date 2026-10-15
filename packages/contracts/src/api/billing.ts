import { z } from "zod";
import { idSchema } from "../ids.ts";

// Plans and what an organization may do on its plan (Stage 9). The names of the plans are data, but the API shape is closed.

export const PLAN_KEYS = ["free", "team", "enterprise", "employer"] as const;
export const planKeySchema = z.enum(PLAN_KEYS);

// The switches and limits a feature asks about. Adding one is a migration, a field here and a test.
export const entitlementsSchema = z
    .object({
        plan: planKeySchema,
        name: z.string().min(1).max(60),
        members_max: z.number().int().min(1),
        env_runs_per_month: z.number().int().min(0),
        verifications_per_month: z.number().int().min(0),
        webhook_endpoints_max: z.number().int().min(0),
        sso: z.boolean(),
        scim: z.boolean(),
        employer_search: z.boolean(),
    })
    .strict();
export type Entitlements = z.infer<typeof entitlementsSchema>;

export const FEATURES = ["sso", "scim", "employer_search"] as const;
export const LIMITS = [
    "members_max",
    "env_runs_per_month",
    "verifications_per_month",
    "webhook_endpoints_max",
] as const;
export type Feature = (typeof FEATURES)[number];
export type Limit = (typeof LIMITS)[number];

export const setPlanRequestSchema = z
    .object({
        plan: planKeySchema,
        billing_ref: z.string().min(1).max(120).nullable().default(null),
        contract_ref: z.string().min(1).max(120).nullable().default(null),
    })
    .strict();

export const planChangedSchema = z
    .object({ org_id: idSchema("org"), entitlements: entitlementsSchema })
    .strict();

// What an organization used in one calendar month (UTC), beside the limits of its plan.
export const usageResponseSchema = z
    .object({
        period_start: z.iso.datetime(),
        period_end: z.iso.datetime(),
        env_runs: z.number().int().min(0),
        employer_reports: z.number().int().min(0),
        env_runs_limit: z.number().int().min(0),
    })
    .strict();

// Plans a person can buy by card. Free needs no purchase and enterprise is a contract set by staff.
export const SELF_SERVE_PLANS = ["team", "employer"] as const;
export const checkoutRequestSchema = z.object({ plan: z.enum(SELF_SERVE_PLANS) }).strict();
export const sessionUrlSchema = z.object({ url: z.url().max(2000) }).strict();
