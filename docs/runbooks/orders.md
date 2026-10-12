# Runbook: orders, deliveries, payments and payouts (Stage 4A)

All of this is done by platform administrators through the API until the admin pages exist (F43).
Every change needs a fresh passkey check (sign in with a passkey within the last 15 minutes). Replace
`$API` with the API origin and send the session cookie and the header `x-aura-request: 1`.

## Sell a pack
1. The customer is a **company** or **AI lab** organization that exists and has at least one member. Make
   the buyer's person a member with the role `buyer` (the organization's owner invites them, role
   `buyer`).
2. Create the order: `POST /api/v1/admin/orders` with `customer_org_id`, `title`, `licence_terms` (shown
   to the customer inside the manifest) and `delivery_days` (how long downloads work, 1 to 365).
3. Add each **released** task version: `POST /api/v1/admin/orders/:id/items` with `task_version_id`.
   Remove a mistake with `DELETE /api/v1/admin/orders/:id/items/:versionId`. A draft order can also be
   cancelled: `POST /api/v1/admin/orders/:id/cancel`.
4. Record the invoice you issued elsewhere: `PUT /api/v1/admin/orders/:id/invoice` with
   `invoice_reference`.
5. Place it: `POST /api/v1/admin/orders/:id/place`. This freezes the order, creates the delivery
   (`pending`) and queues the build job. The worker builds the manifest within seconds; the customer's
   page then shows the delivery as ready.
6. When the customer pays: `POST /api/v1/admin/orders/:id/paid` (once).

## Check a delivery
`GET /api/v1/admin/orders/:id` shows the delivery state. `pending` for more than a few minutes means
the worker is not running or the job failed: look for a `delivery.build` job in state `dead` (and see
F42 if a version was retired after ordering). Nothing about the customer's download log is in the
portal for staff yet; query `delivery_access` in the database (read-only) for who downloaded what.

## Revoke
`POST /api/v1/admin/deliveries/:id/revoke` with a `reason`. Takes effect at once for new links; links
already issued live at most five minutes. A revoked delivery cannot be revived: place a new order.

## Contractor payouts
Agree: `POST /api/v1/admin/payouts` with `contractor_id`, `task_version_id` (they must have authored
that released version), `amount_minor` (cents) and `currency` (for example `USD`). After you have paid
them outside the system: `POST /api/v1/admin/payouts/:id/paid` with a `reference`. The contractor sees
their own payouts at `GET /api/v1/me/payouts`.

## Assign people to a task
Owners and admins: `POST /api/v1/tasks/:id/assignments` with `user_id`, or use the "Who works on this
task" section of the task page. Reviewers see nothing of a task until they are assigned.

## The customer's verification
The portal shows the manifest's SHA-256. The customer runs `shasum -a 256 manifest.json` and the same
for each downloaded file. We keep `tools/verify-delivery-cli.ts` for support: `node
tools/verify-delivery-cli.ts --manifest manifest.json --bundles <folder> --manifest-sha256 <hash>`.

## What not to promise
Every delivery says `validation: not performed`. Do not tell a customer a pack is validated until
Stage 4B has run (F41, F32).
