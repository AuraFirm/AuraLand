# Stage 9 plan: business systems, scale, compliance

Status: **approved by the owner's standing delegation on 2026-10-15** ("take the best possible decisions and go ahead"); every
default below is therefore chosen, and any of them can still be overruled. Kit: `docs/kit/12` Stage 9, `03` (payments, queue
triggers), `05` (`customers`, residency), `06` (billing, outbound webhooks), `08` (SSO, SCIM, bug bounty, DR), `15` (D1, D2, D3).

## 1. Where this starts
Stages 1 to 8 are built. Reusable: orgs and roles, API keys with step-up, audit chain, the job queue and worker ticks, the egress
client (SSRF-safe), payouts (Stage 4A), `orgs.data_region`, the storage port, the simulation harness, the Next renderer.
**Nothing for billing, enterprise sign-in, customer webhooks or compliance evidence exists.**

## 2. Honest limits of this stage (read this first)
- **No Stripe account, no legal entity (D1, D2).** I build a `BillingPort`, a fake adapter, and the webhook receiver with Stripe's
  documented signature scheme (timestamp plus HMAC-SHA-256 of `t.payload`, 5-minute replay window, idempotent by event id) tested
  with signatures I compute. **No real Stripe call is ever made or claimed**; the Stripe adapter is written only after an account
  exists to run it against (F77). No tax, no invoices PDF, no dunning.
- **No identity provider.** Enterprise sign-in is OIDC behind `AuthPort`, tested against an in-process fake IdP that signs real
  JWTs and serves discovery and JWKS. **SAML is not built** (it needs an XML-signature library and a conformance partner: ADR and
  a customer first, F78). SCIM is the minimal Users resource. "Conformance" here means my tests, not a certification.
- **No cloud, auditor, or second region.** SOC 2 work is an evidence collector (it reads the repository and database and writes a
  dated report) and a readiness checklist; **no SOC 2 report exists or is claimed**. The DR drill is a restore of a logical dump into
  a scratch database with the audit chain and row counts compared; point-in-time recovery and multi-AZ cannot be drilled (F79).
  Data residency is storage-bucket routing by `orgs.data_region` plus a written design for a database split; one region exists.
- **Cost per verification** is metered counts times configured unit costs (illustrative until a real bill exists), not a measurement.
- **No marketplace of buyers**: the revenue-share ledger and payout batches are built; no real money moves (the payout rail is a
  port with a fake, as in Stage 4A).
- ClickHouse, Valkey and NATS: **not built**; the kit's triggers are checked in the report and none has fired.

## 3. Decisions (my default, chosen under the delegation)
1. **Order.** Plans and entitlements first (everything else asks them), then metering, billing port and webhooks, customer
   webhooks, SSO and SCIM, org admin console, marketplace ledger, employer subscriptions, developer portal and SDK, support
   tooling, then compliance (residency, evidence, DR, bug bounty, framework ADR) and the report.
2. **Money** is `amount_minor bigint` plus `currency char(3)`; no floats anywhere; the ledger is append-only with a balancing check.
3. **Entitlements are checked server-side in one function**; plans are data (a table), not code; unknown plan means the free plan.
4. **Metering** is an append-only event table keyed by an idempotency key; usage per org per month is a fold; billing
   reconciliation compares our fold with the provider's lines through the port.
5. **Customer webhooks** are signed (HMAC-SHA-256, timestamp, per-endpoint secret shown once, stored encrypted-free as a hash is
   impossible for HMAC, so stored with the application secret box already used for login tokens if it exists, else an ADR),
   delivered by the worker with retry and a dead-letter, SSRF-checked at resolve and again at connect.
6. **SSO** is OIDC authorization-code with PKCE, per-organization, domain verified by a DNS TXT proof through a resolver port;
   JIT provisioning; SCIM bearer tokens hashed. A person with SSO enforced cannot use other sign-in for that org.
7. **Impersonation** only with the target's consent token, time-boxed, read-only by default, every action audited with both ids,
   never of a platform administrator, never during an exam sitting.
8. **Developer SDK** is a small TypeScript package generated from the contracts' schemas (a new `packages/sdk`, ADR first), no
   runtime dependency beyond fetch.
9. **Web-framework re-evaluation** is a written ADR from the facts in the repo, not a migration.
10. **New dependencies**: none planned (Stripe signatures and OIDC verification use `node:crypto` and the existing `jose`); any
    addition needs an ADR first.

## 4. Work breakdown (one pull request each, tests first; report after each part)
**9A: money**
| # | Slice | Verify |
|---|---|---|
| 0 | This plan, ADR 0036 (decisions, limits), threat model v12 | review |
| 1 | `plans`, `customers`, entitlements function, RLS and matrix rows | db and HTTP tests, authz matrix |
| 2 | Metering events and monthly usage fold; verifications and env runs are recorded once | idempotency tests, simulation of retries |
| 3 | `BillingPort`, fake adapter, checkout and portal sessions, Stripe-style webhook receiver (signature, replay window, idempotent) | forged, replayed, reordered and duplicate events |
| 4 | Reconciliation: our usage versus the provider's lines; money ledger with a balancing check | reconciliation tests, mutation checks |
**9B: enterprise**
| # | Slice | Verify |
|---|---|---|
| 5 | Customer webhooks: endpoints, signed deliveries, retry, dead letter, SSRF-safe | rebinding and private-address tests, replay tests |
| 6 | OIDC SSO with a fake IdP, domain verification, enforcement; SCIM Users | conformance tests (alg confusion, nonce, state, issuer, audience) |
| 7 | Org admin console (members, SSO, SCIM, webhooks, usage) | browser tests with axe |
**9C: marketplace and growth**
| # | Slice | Verify |
|---|---|---|
| 8 | Setter revenue-share ledger and payout batches | ledger balances, duplicate-run tests |
| 9 | Employer subscriptions as an entitlement; developer portal (keys, quotas, docs) and TS SDK | contract tests, SDK against the real app |
| 10 | Support tooling: impersonation with consent and audit | refusal tests, audit rows |
**9D: compliance**
| # | Slice | Verify |
|---|---|---|
| 11 | Residency routing and design ADR; SOC 2 evidence collector and checklist; DR restore drill; bug-bounty policy and `security.txt`; framework re-evaluation ADR; cost per verification; runbooks; ASVS rows; Stage 9 report | the drill's numbers, the evidence report |

## 5. Security notes
Webhook secrets and SSO client secrets are never logged, shown once, and kept out of audit payloads. The Stripe webhook route has no
session and is the only unauthenticated write route besides sign-in; it verifies the signature over the raw body before parsing.
Entitlements fail closed. SCIM and SSO create people, so they are audited and rate limited. Impersonation is the highest-risk
function in the stage and gets its own tests before any screen.

## 6. What this still will not do
Real payments, taxes, invoices, SAML, a SOC 2 report, multi-region, PITR/DR across zones, a bug-bounty payout, ATS vendor-specific
connectors (the generic signed webhook and API are the integration), or any figure about cost or capacity.

## 7. Things only you can provide
A legal entity and Stripe (or a merchant of record) account (D1, D2, F77); a customer who needs SAML (F78); a cloud account with
backups for a real DR drill (F79, F1); a SOC 2 auditor and policies the company adopts; a bug-bounty platform and budget; a lawyer
for the sub-processor list and DPAs; pricing (plan names, limits and prices are placeholders I choose).
