# Stage 9 report: business systems, scale, compliance

Status: built, awaiting your review. Plan: [stage-9-plan.md](stage-9-plan.md). Decisions and amendments: `docs/adr/0036-stage-9-decisions.md`
(plus 0037 web framework, 0038 data residency). Runbook: [../runbooks/business.md](../runbooks/business.md). ASVS:
[../security/asvs-matrix-stage-9.md](../security/asvs-matrix-stage-9.md). Evidence: [../compliance/evidence-2026-10-15.md](../compliance/evidence-2026-10-15.md).
**Everything ran against fakes and a development database: a fake payment provider, a fake OpenID Connect provider that mints real signed
tokens, a fake DNS. No money moved, no real identity provider or customer was involved, there is no cloud, and no audit took place.**

## What exists
| Slice | What | PR |
|---|---|---|
| 0 | Plan accepted by delegation, ADR 0036, threat model v12 | #131, #132 |
| 1 | Plans, customers and one entitlements function; plan set only by a platform administrator | #132 |
| 2 | Usage events written by triggers; the monthly view; the plan's run allowance (`plan_limit_reached`, 402) | #133 |
| 3, 3b | Payment-provider port with a fake; Stripe-style webhook (signature, window, once, out-of-order safe); checkout and portal | #134, #135 |
| 4 | Double-entry ledger that must balance at commit; monthly reconciliation of usage against the provider | #137 |
| 5a, 5b | SSRF-safe client for customer-chosen addresses; webhook endpoints, signed deliveries, retry and dead-letter | #136, #138 |
| 6a, 6b | OIDC connections, DNS domain proof, id_token checks, SSO sign-in with membership and plan room, enforcement | #139 |
| 6c, 7 | SCIM Users with bearer tokens; the organization admin console and its browser tests | #140 |
| 8 | Setter revenue share through the ledger; payout batches | #141 |
| 9 | Employer access needs a subscription; a developers page (no SDK: see below) | #141 |
| 10 | Consented, read-only support access (not impersonation: see below) | #141 |
| 11 | Residency routing primitive, evidence collector, disaster-recovery drill, bug-bounty draft, framework ADR, cost report, runbook, ASVS rows, this report | #141 |

## Verified (with evidence)
- **Money cannot be silently wrong**: the ledger refuses, at commit and even for writes that bypass the posting function, any transaction whose
  debits and credits differ in some currency; revenue is booked once per order item and split with rounding to the platform; a payout batch reserves
  exactly what is available and posting it zeroes the debt (`ledger.database.test.ts`, `http-revenue.test.ts`).
- **The payment webhook** accepts only a genuine, fresh signature over the exact bytes (tested against signatures computed with `node:crypto`, never
  against Stripe), applies an event once, never over a newer event and never over a plan staff set by hand.
- **SSRF**: customer webhook and identity-provider addresses cannot reach inside: a table of private, loopback, link-local, metadata, shared and
  reserved addresses (and IPv4-mapped IPv6) is refused; the address checked is the address connected; a real local server counts connections, and
  "blocked" means none was made.
- **SSO**: a person is recognised by (organization, subject), not email; an existing account is attached only through a DNS-proved domain; every check on the
  token and on the flow refuses without a session; a full organization leaves no stray account; enforcement closes email, passkey and OAuth sign-in for
  the organization's people except its owners.
- **SCIM**: tokens are unguessable, hashed, shown once; only verified-domain addresses; owners are never removed; deprovisioning ends SSO sessions and bars SSO.
- **Webhook delivery**: signed `t=,v1=`, previous secret valid 24 hours after rotation, backoff 30 s doubling to 4 h, dead after 24 h, claims with `skip locked`.
- **Disaster-recovery drill** (logical dump to an empty database): dump 1.0 s, restore 1.3 s, 900 KiB, 2,447 rows in 86 tables, every count equal and the audit
  chain verifies with the same head. This drills the procedure, not production.
- **SOC 2 readiness evidence** (automatic): 7 evidenced, 3 partial, 2 not evidenced; the two gaps (incident response, access review) need people.
- Gates: `pnpm check` exit 0 on every branch (earlier branches' lint failures were hidden by a pipe I used and fixed; the lesson is in the PR history);
  CI (`verify` with the browser tests, `images`, `semgrep`, `secrets`, CodeQL) green on #131 to #139; #140 and #141 (which also fixed a 1-in-64 flaky Stage 8 test and an axe finding on the new developers page) green after re-runs of registry rate limits.

## Deviations from the plan (all decided under your delegation)
1. **No SDK.** API keys reach only `GET /key`; an SDK would wrap routes it cannot call. F83 is the design that comes first.
2. **No impersonation.** Staff get a consented, read-only account summary recorded with the data, visible to the person. Acting as a person would add a
   second kind of actor to every authorization check.
3. **Data residency is a primitive, not a promise.** Region-routed storage exists and fails loudly for an unconfigured region, but no call site is switched
   and there is one (undeployed) region. Do not tell a customer "EU data residency".
4. **Customer webhooks fire for one event** (`env_run.finished`); `credential.issued` is accepted in endpoints but nothing raises it yet (F82).
5. **Employer subscriptions** are a plan switch on top of the existing approval, purchasable by card through the fake checkout.

## Mistakes and fixes worth knowing
- Several branches reached review with tigerlint violations because I piped `pnpm check` through `grep` and read only the first lines; the check chain stops at the
  first failure. Fixed on each; I now read the exit code.
- A drill I wrote at first blamed a run for debris an earlier session had left (Stage 8); fixed by comparing before and after.
- The authorization-matrix test creates an owned organization per row and ran into the 20-organization-per-person cap; each victim organization now has its own owner.
- CI registry rate limits (429) failed `images` several times; re-runs passed.

## Not verified, not built
- A real Stripe adapter, taxes, invoices, dunning (F77). SAML and IdP-initiated login (F78). A real DR drill with backups and a second region (F79).
  A rate limit on SCIM (F80). SCIM Groups (F81). More webhook events and a delivery screen beyond the console's list (F82). Key scopes and an SDK (F83).
- OIDC and SCIM against a real provider; the browser console against a real screen reader (axe passes).
- The kit's targets "billing reconciliation tests" (done, fake), "SSO conformance tests" (our own, against a fake), "SOC 2 Type I readiness checklist" (evidence list, not a
  report), "DR drill" (procedure only), "cost per verification tracked" (a calculator with placeholder costs) are met only in those senses.

## Decisions I made that you may overrule
Placeholder plans and prices; owners exempt from SSO enforcement; employer plan buyable by card; 24-hour cap on support grants; 24-hour delivery window for webhooks; staying on Next.js (ADR 0037).

## Next
You: `docs/owner-tasks.md` section 3.11. Engineering when unblocked: F77 to F83, F68 to F76, then the kit's remaining items.
