# 0028 — Stage 4A decisions (Forge v0 without the sandbox)
Status: accepted
Date: 2026-10-12

## Context
The owner approved `docs/stages/stage-4-plan.md` with all defaults ("I approve the defaults, go ahead
with 4A"). Validation, calibration and attacker runs depend on a sandbox that has never run (cutlist
F32), so only the part that does not need it is built now.

## Decision
1. 4A ships before the sandbox gate. Every delivery states `validation: not performed` until 4B.
2. A customer is an organization of kind `company` or `ai_lab`. New membership role `buyer` sees that
   organization's orders and deliveries only. Orders are created by platform administrators; there is
   no self-serve payment.
3. A delivery is a canonical JSON manifest (task versions, bundle SHA-256 and size, licence terms,
   watermark id, validation status) whose SHA-256 is stored and checked by the database. The customer
   downloads the original verified bundles; `tools/verify-delivery.ts` checks them against the manifest.
4. Watermark in 4A: a per-delivery canary line inside the statements carried in the manifest. Test-data
   perturbation is deferred to 4B because rewriting bundles parses archives (sandbox-only rule).
5. Downloads: five-minute signed URLs, issued only after an authorization check, every issue logged;
   deliveries expire (default 30 days per order) and can be revoked.
6. Billing behind a `BillingPort` with a manual adapter (invoice reference typed in by staff).
7. Contractor payouts are records only.
8. Order and delivery writes go through SECURITY DEFINER functions that check the platform role
   themselves (same pattern as `verify_org`); `aura_app` gets no insert/update on these tables.
9. No new dependencies.

## Alternatives considered
Self-serve checkout (kit says out of scope); rebuilding bundles with watermarks now (parses archives
outside a sandbox); a Stripe adapter now (needs an account and legal entity, D1).

## Revisit trigger
The Linux node gate passes (4B starts), or a customer needs self-serve ordering.
