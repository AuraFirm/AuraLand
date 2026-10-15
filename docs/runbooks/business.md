# Business systems runbook (plans, billing, webhooks, SSO, SCIM, revenue, support, DR)

For the person operating the product. **Everything here ran against fakes and a development database: there is no Stripe account, no
identity provider, no cloud, and no customer.** Read `docs/adr/0036-stage-9-decisions.md` first. Limits and open work: `docs/cutlist.md` F77 to F83.

## 1. Plans and usage
```sql
select org_id, plan, source, updated_at from customers order by updated_at desc limit 20;       -- who is on what (source: staff or provider)
select kind, count(*) from usage_events where occurred_at >= date_trunc('month', now()) group by 1;   -- this month's billable events
select period, status from reconciliations order by period desc limit 6;                         -- 'differences' needs a person
```
Put an organization on a plan (platform administrator, fresh passkey check): `PUT /api/v1/admin/orgs/{id}/plan {"plan":"enterprise"}`.
Plan numbers and prices are placeholders; change them by migration (`plans`). A plan set by staff is never changed by the payment provider.

## 2. Payment provider (fake only)
`AURA_BILLING_DRIVER=fake` in local and test; unset elsewhere, which makes checkout and the portal answer 503. The webhook
(`POST /api/webhooks/stripe`) exists only when `AURA_STRIPE_WEBHOOK_SECRET` is set. When a real adapter exists (F77), expect to: create the
endpoint in Stripe, set the secret, send a test event, watch `billing_events` get a row with outcome `applied`.
Reconciliation differences: read `reconciliations.differences`; they are never repaired automatically. Decide whether we or the provider
is wrong, fix the source, and note it.

## 3. Customer webhooks
```sql
select state, count(*) from webhook_deliveries group by 1;
select last_reason, count(*) from webhook_deliveries where state = 'dead' group by 1 order by 2 desc limit 10;
```
A customer reports missing events: check their endpoint is `active`, that `webhook_deliveries` has rows for the event, and `last_reason`
(`receiver answered 500`, `address not allowed`, `timed out`). `address not allowed` means their name resolves to a non-public address; we
will never deliver there. Rotating a secret keeps the old one signing for 24 hours.

## 4. Single sign-on and SCIM
Set-up order for a customer: plan with SSO, connection (issuer, client id and secret), domain TXT record, verify, sign in once through SSO
as the administrator, then (optionally) require it, then SCIM token. If their provider is down and SSO is required, **owners** can still
sign in with a passkey or email link; anyone else waits. To lift a mistaken requirement: `PUT /orgs/{id}/sso/enforcement {"enforced":false}` as an
owner, or `update sso_connections set enforced = false where org_id = '...'` as a last resort with a note in the audit trail.
A person SCIM-switched-off cannot return through SSO until the provider switches them on again.

## 5. Revenue share and payouts
Order of work: set terms per task, book each order item's revenue once, create a payout batch, pay outside the product, mark the batch paid
with the bank reference. Check the ledger at any time: for every transaction debits equal credits; `select account, sum(...) from ledger_entries`
gives balances. A batch that was created by mistake is cancelled, which frees the reservation. Nothing moves money; "paid" records a reference.

## 6. Consented support access
The person grants access (up to 24 hours) and sees every look; staff read `GET /admin/support/users/{id}`. There is no way to act as someone.
If a person says someone looked who should not have: `select * from support_views` and the audit actions `support.account_viewed`.

## 7. Disaster-recovery drill (logical dump and restore)
`node apps/api/src/dr-drill-cli.ts` seeds a database, dumps it, restores into an empty database and checks every table's row count and the audit
chain. Last run on the development machine: dump 1.0 s, restore 1.3 s, 900 KiB, 2,447 rows in 86 tables, passed. **That is a drill of the
procedure, not of production**: no managed backups, point-in-time recovery or second zone exist (F79). Run it after any migration that adds tables.

## 8. Evidence for SOC 2 readiness
`node apps/api/src/soc2-evidence-cli.ts` writes `docs/compliance/evidence-<date>.md` from the repository, CI, GitHub's rules and a fresh database.
It is a dated list of what can be shown automatically and, as plainly, what cannot. It is not an audit.

## 9. Cost per verification
`apps/api/src/cost-per-verification.ts` multiplies usage counts by unit costs from `docs/compliance/unit-costs.json`. Those costs are placeholders;
nothing it prints is a real cost until someone replaces them with figures from a bill.
