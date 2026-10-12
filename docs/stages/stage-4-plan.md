# Stage 4 plan (draft): Forge v0, author → validate → deliver

Status: **draft for your review. No Stage 4 code starts until you approve it.** Kit reference:
`docs/kit/12` Stage 4, `docs/kit/05` (orders, deliveries), `docs/kit/08` section 5, `docs/kit/01`.

## 1. The honest starting point
Stage 4 sells task packs and private evals to a paying customer. Two things in it depend on a judge that
can run code safely, which does not exist yet (`docs/stages/stage-3-report.md`): **validation** (does the
reference solution pass, do the bad solutions fail, mutation testing, difficulty calibration, attacker
agents) and **anything a customer might run against our tasks**. Everything else in Stage 4 is
independent of the sandbox: customers, orders, delivery packaging with watermarks, signed downloads,
access logs, billing hand-off, contractor payout records, the authoring workspace, the methodology page.

So the plan has two parts: **4A (buildable now, no sandbox)** and **4B (starts only after the Linux
node gate, cutlist F32)**. 4A can ship value (a pack can be assembled and delivered with the
"unvalidated" flag shown plainly); 4B turns "unvalidated" into a score.

## 2. Decisions I need from you (my default in bold; "defaults" accepts all)
1. **Start 4A before the sandbox gate?** **Yes**, with every delivery carrying a visible
   `validation: not performed` field until 4B lands. No (wait) is the safe alternative.
2. **Customer model.** **A customer is an organization (kind `company` or `ai_lab`) with a new role
   `buyer`** who can see its own orders and deliveries only; sales staff (platform administrators for
   now) create orders. No self-serve payment (kit out of scope).
3. **Delivery content.** **A delivery is a signed manifest (JSON: task versions, bundle SHA-256s, sizes,
   licence terms, watermark id) plus per-delivery perturbed bundles**; the manifest hash is stored and
   a verification script lets a customer check what they received.
4. **Watermarking.** **Per-delivery canary strings in statements and non-semantic perturbations of test
   data (for example permuted sample order, reordered independent test cases, harmless whitespace
   canaries), logged by `watermark_id`.** Perturbations must keep every verdict identical; a test proves
   it with the validator and, in 4B, with the judge.
5. **Downloads.** **Short-lived (5 minute) signed URLs issued only after an authorization check, every
   issue logged (who, when, delivery, address), deliveries expire** (default 30 days, per order).
6. **Billing.** **A `BillingPort` with a manual adapter (contract fields on the order, invoice reference
   typed in by staff) now; the Stripe invoices adapter later.** No card handling in our system.
7. **Contractor payouts.** **A record only** (who authored which versions, agreed amount, paid yes/no,
   paid date); payment itself stays manual.
8. **Authoring workspace restrictions.** **Setters can read only tasks they create or are assigned; no
   bulk export; every bundle read is logged.** Reviewers read what they are assigned.
9. **Comments.** **Threaded comments on a version, visible to setters and reviewers of the organization,
   rendered with `renderMarkdownSafe`.**
10. **Methodology page.** **A static page in the web app, versioned with the code** (it documents the
    validation formula once 4B defines it).

## 3. Assumptions
Roles, tenancy and audit as in Stage 1; storage and bundle format as in Stage 2; queue and worker as in
Stage 3. New tables follow the existing pattern (UUIDv7, `org_id`, forced row-level security, rows in the
RLS matrix and ADR 0003, column grants). New dependencies: none planned (signing the manifest uses
`node:crypto`; no PDF or invoice library). Delivery packaging runs on the worker as `aura_worker`, never
on the API request path, because it rebuilds bundles (reads and rewrites archives): **rebuilding a
bundle parses an archive**, so packaging uses the Stage 2 canonical writer on bytes the validator has
already accepted, and runs only after F30 makes validation real; until then 4A packages only *the
original verified bytes* with a watermark carried in the statement and manifest, not in test data
(decision 4 test-data perturbation moves to 4B).

## 4. Work breakdown (4A, small slices, one pull request each)
| # | Slice | Verify |
|---|---|---|
| 0 | ADR for Stage 4 decisions; contracts (ids `ord`, `dlv`, manifest schema) | contract tests |
| 1 | Migration: `orders`, `order_items`, `deliveries`, `delivery_access`, role `buyer`; RLS so buyers see only their organization's rows | two-organization tests, trigger tests, mutation checks |
| 2 | Order routes for platform administrators (create, list, attach released versions, set licence and expiry) | authorization matrix, audit |
| 3 | Manifest builder (pure) and hash; delivery creation job on the worker; manifest verification script (`tools/verify-delivery.ts`) | property tests (any change to a file or field changes the hash), golden manifest |
| 4 | Signed download URLs, access log, expiry, revocation | HTTP tests: expired, revoked, wrong buyer, replay |
| 5 | Customer portal screens (orders, deliveries, download, verification instructions) | browser test with axe |
| 6 | `BillingPort` + manual adapter; contractor payout records | unit tests, audit |
| 7 | Authoring workspace restrictions, bundle-read logging, comments | RLS tests, XSS corpus for comments |
| 8 | Methodology page, threat model v4, ASVS rows, runbook, report | gate checklist |

4B (after F32): validation job on nodes, mutation testing, difficulty calibration through an
`LlmProvider` port, attacker-agent runner, human-attack queue, `ungameability_score`, immutable validation
report, watermarks in test data with equal-verdict proof.

## 5. Security design (key rules)
Customers read only their own deliveries (RLS and code); the platform never serves a bundle except
through an authorized, logged, short-lived URL; manifests are tamper-evident; watermark ids are secrets
to customers (never shown to other customers); setters cannot export other people's tasks in bulk;
nothing about a customer's order appears in a setter's view; licence fields are enforced when issuing a
download (expired, revoked or out-of-scope deliveries are refused).

## 6. Invariants
1. A delivery's manifest hash equals the SHA-256 of its stored manifest, and its items equal released
   versions at the time of delivery.
2. A buyer never reads another organization's order or delivery.
3. Every download URL issue has an access-log row.
4. A revoked or expired delivery issues no URL.
5. No delivery changes after creation (only revocation is recorded).

## 7. Things only you can provide
First paying customer's contract terms (licence wording, expiry, invoicing details); the legal entity
(D1); a payment/invoicing choice for later; a Linux judge node for 4B (`docs/owner-tasks.md` section 1).

## 8. Open questions
Section 2. Anything you answer differently changes slices 1 to 3 (customer model, manifest, watermark
placement).
