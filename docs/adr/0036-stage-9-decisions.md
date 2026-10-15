# 0036 — Stage 9 decisions (business systems, scale, compliance)
Status: accepted
Date: 2026-10-15

## Context
The owner delegated the Stage 9 plan (`docs/stages/stage-9-plan.md`). The stage needs accounts that do not exist (Stripe, an
identity provider, a cloud, an auditor), so every external system is built behind a port with a fake, and nothing here may be
described as having run against the real thing.

## Decisions
1. **Plans are data** (`plans`), organizations are on the free plan unless `customers` says otherwise, and **one function
   (`org_entitlements`) answers "what may this organization do"**. Pure checks (`featureEnabled`, `withinLimit`) fail closed.
   Plan numbers and prices are placeholders chosen by the engineer; changing them is a migration.
2. **Only a platform administrator sets a plan** (`set_org_plan`, checked in the database, fresh passkey check at the route, audited).
   Billing references are readable by the organization's owners and administrators only.
3. **Money** is `amount_minor bigint` plus `currency char(3)`, never a float; ledgers are append-only with a balancing check.
4. **Stripe**: a `BillingPort`, a fake adapter, and a webhook receiver that verifies Stripe's documented signature
   (`t=<timestamp>,v1=<HMAC-SHA-256 of "t.payload">`, 5-minute window, idempotent by event id) with `node:crypto`. No Stripe SDK
   is added. A real adapter waits for an account (F77).
5. **SSO** is OIDC (authorization code with PKCE), per organization, with DNS TXT domain verification through a resolver port.
   **SAML is not built** (F78). SCIM is the Users resource only.
6. Webhook secrets for customers are kept readable by the worker role only, shown once, rotated by replacement.
7. The compliance work is evidence and drills that can run here; **no SOC 2 report and no multi-region claim** is made (F79).

## Alternatives considered
Entitlements as code constants (rejected: a sale would need a deploy). Entitlements in the session (rejected: stale after a plan
change). The Stripe SDK (rejected for now: one more dependency to audit for a signature check we can write and test). A hosted
SSO broker such as WorkOS (kit 03: add only when a customer demands SAML/SCIM at volume).

## Consequences
New tables carry RLS and rows in ADR 0003. Each feature that is sold asks `org_entitlements`, so adding a plan switch is a
migration, a contract field and a test.

## Verification
`rules.test.ts`, `http-billing.test.ts`, the authz matrix and the RLS matrix; later slices add reconciliation, signature and
conformance tests.

## Revisit trigger
The owner sets real prices or plans; a customer needs SAML; a real Stripe account exists.

## Amendments
- **Slice 9: no SDK.** The plan listed a TypeScript SDK. API keys reach only `GET /key` (every other route asks for a person), so an
  SDK would wrap routes it cannot call. What would make keys useful (scopes, an organization acting under row-level security) is a
  design of its own and is cutlist F83. The developer page says so. Employer subscriptions are done: `employer_is_approved` now needs
  the platform administrator's approval AND a plan with employer search.

