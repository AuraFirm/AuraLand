# Stage 4A report: Forge v0 without the sandbox (author, order, deliver)

Status: **ready for your review.** You approved the plan with all defaults ("I approve the defaults, go
ahead with 4A"). This part of Stage 4 is everything in `stage-4-plan.md` that does not need the sandbox.
**4B (validation, mutation testing, calibration, attacker runs, `ungameability_score`, test-data
watermarks) is not started and cannot be until the Stage 3 gate passes (cutlist F32).** Decisions are in
ADR 0028.

## Read this first: what is verified and what is not
| Claim | State |
|---|---|
| Orders and deliveries rules live in the database (released versions only, frozen once placed, manifest set once with a hash the database recomputes, append-only download log, customer-only reads) | **Verified** (`orders.test.ts`, `payouts.test.ts`, `rls-matrix.test.ts`) |
| Only platform administrators write; customers and setters cannot even see the routes | **Verified** (`http-orders.test.ts`, authorization matrix) |
| The worker builds a manifest from a placed order and stores it | **Verified** against a real database as the worker role (`handlers.database.test.ts`) |
| A customer's buyer lists deliveries, reads the manifest hash and gets a five-minute link, logged | **Verified** in HTTP tests and in a real browser (`http-deliveries.test.ts`, `deliveries.spec.ts`) |
| Expired, revoked, pending, foreign and unknown-bundle requests issue no link and write no log row | **Verified** |
| The customer can check what they received | **Verified**: `shasum` instructions in the portal, and `tools/verify-delivery-cli.ts` (tests refuse a changed manifest, a changed, missing or wrongly sized bundle) |
| Payment records and contractor payouts (once only, never deleted, private to the contractor and staff) | **Verified** |
| Setters and reviewers see only their own or assigned tasks | **Verified** (`http-assignments.test.ts`, `tasks.test.ts`, browser test) |
| Comments on versions (append-only, safe rendering, staff only) | **Verified** (`http-comments.test.ts`, browser test with a hostile comment) |
| **Any pack is validated** | **No.** Every delivery says `validation: not performed`; the methodology page says so. Needs the sandbox |
| **A leaked bundle can be traced to its customer by content** | **No.** Only statements carry a per-delivery canary; the download log is the other trace. Bundle and test-data watermarks come with 4B |
| A real customer has been served, a real invoice issued, a real payment made | **No.** No customer, entity or provider exists (D1, F44) |
| Deployed anywhere | **No** (F1) |

## What was built, in the order it merged
| Slice | Pull request | What it adds |
|---|---|---|
| 0–1 | #48 | ADR 0028; migration 0020: `orders`, `order_items`, `deliveries`, `delivery_access`, the `buyer` role, platform-admin functions; 13 database tests |
| 2 | #49 | Admin order routes (create, add or remove items, invoice reference, place, cancel, revoke), step-up on writes, audit, authorization matrix rows |
| 3 | #50 | Migration 0021 (two worker-only functions), pure manifest rules, the `delivery.build` job, `tools/verify-delivery-cli.ts` |
| 4 | #51 | Migration 0022 (`issue_delivery_download` decides and logs in one step), customer read routes, five-minute links, rate limit |
| 5 | #52 | Customer pages: list, detail, per-bundle download, manifest hash and verification commands |
| 6 | #53 | Migration 0023: order payment record, contractor payouts, `BillingPort` with the manual adapter |
| 7a | #54 | Migration 0024: task assignments; setters and reviewers limited to their own or assigned tasks; assignment routes and task-page section |
| 7b | #55 | Audit entry for every bundle link granted to a judge node |
| 7c | #56 | Migration 0025: comments on versions; UI section |
| 8 | this report | Threat model v4, ASVS V14 and V16 mapping, runbook, methodology page, cutlist F40–F46 |

## Decisions I made inside your defaults (challenge these)
1. **Download links go to a presigned storage URL**, as for judge nodes, so the API never streams
   bundles. The signature is in the query string for five minutes (ASVS V14.2.1 partial).
2. **A delivery is one per order**, built by the worker after placement, so placing never waits for a
   hash. If a version is retired between ordering and building, the build refuses and the job dies loudly
   (F42).
3. **Payments are records, not flows.** `BillingPort` has one method and one manual adapter; it exists so
   a provider can replace staff typing without touching the routes (F44).
4. **The authoring restriction is a database rule, not only a route rule.** It changed behavior from
   Stage 2: a reviewer sees nothing of a task until the owner assigns them. Existing tests were updated
   to assign reviewers explicitly; new tests cover the rule and its removal.
5. **Comments are append-only** (a correction is a new comment) and visible only to staff on the task
   and owners and admins, not to plain members even of a released version.
6. **Contractors are paid per released version they authored**; the database refuses a payout for
   anyone else.

## Known gaps (ranked; all in `docs/cutlist.md`)
1. **Nothing is validated** and bundles are not watermarked (F41, F32).
2. No administrator pages: staff use the API and the runbook (F43).
3. A retired version in a placed order stalls its delivery with no screen to fix it (F42).
4. No payment provider, tax handling or legal entity (F44, D1).
5. Data classification, logging inventory and log shipping are unwritten (F40).
6. Items from earlier reports still stand (sandbox gate, edge, accounts).

## Operational readiness
- Runbook: `docs/runbooks/orders.md` (selling a pack, checking and revoking a delivery, payouts,
  assignments, what not to promise).
- Dashboards and alerts: none (F1, F39).
- Rollback: redeploy the previous image; migrations 0020 to 0025 only add. A delivery in the field keeps
  working because manifests and rows never change.

## Metrics vs targets
| Target (kit, Stage 4) | Result |
|---|---|
| Author → validate → deliver in one flow | Author and deliver: **done**. Validate: **not possible yet** |
| Adversarial validation harness, `ungameability_score` | **Not started** (4B) |
| Orders, deliveries, watermarking | Orders and deliveries **done**; watermarking **statement canary only** |
| Customer portal | **Done** (list, detail, download, verify) |
| `BillingPort`, contractor payout records | **Done** (manual adapter; records only) |
| Methodology page | **Done**, and it says what is not done |

## Suggested reading order for the human review
1. `packages/db/migrations/0020_orders.sql`, `0022_delivery_downloads.sql`, `0023_billing_payouts.sql`, `0024_task_assignments.sql`, `0025_version_comments.sql`.
2. `apps/api/src/modules/orders/` (`rules.ts`, `handlers.ts`, `routes.ts`, `delivery-routes.ts`).
3. `docs/runbooks/orders.md` and `docs/threat-model.md` v4.
4. The browser tests `apps/e2e/src/tests/deliveries.spec.ts` and `tasks.spec.ts`.

## Your remaining manual tasks
- [ ] Read the code above and challenge ADR 0028; reply "Stage 4A approved" or list changes.
- [ ] Decide whether to look for a first customer before 4B: what you can honestly offer is task packs
      with provenance, hashes and the statement "not validated" (see the methodology page).
- [ ] The sandbox gate in `docs/owner-tasks.md` section 1 is still the blocker for 4B.
- [ ] Legal entity and payment provider (D1, F44) when there is a customer to invoice.
