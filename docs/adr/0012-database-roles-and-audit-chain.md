# 0012 — Database roles, row-level security and the audit hash chain
Status: accepted
Date: 2026-10-10

## Context
Stage 1 needs tenant isolation that does not depend on application code being right, an identity
path that can work before anyone is logged in, and an audit log that detects tampering
(docs/kit/05 sections 5 and 6, docs/kit/08).

## Decision
- **Two group roles, `aura_app` and `aura_auth`** (migration 0002), both `NOLOGIN`. Operations makes a
  login role that belongs to both, and each transaction switches to exactly one with `SET LOCAL ROLE`.
  `aura_app` serves tenant data under row-level security; `aura_auth` does pre-login identity work
  and never touches tenant tables. Column-level grants limit what a person may change about
  themselves (only `deletion_requested_at` on `users`).
- **Every table has row-level security enabled and forced**, keyed on the transaction-local
  settings from `withRequestContext` (`app.user_id`, `app.org_ids`). The exception is `audit_log`
  (below). `rls-matrix.test.ts` reads the real schema and fails when a table lacks RLS or a policy,
  or is missing from the ownership map in ADR 0003.
- **Audit log hash chain in the database** (migration 0004). A `BEFORE INSERT` trigger takes an
  advisory lock, assigns the sequence number after the lock (so sequence order is commit order),
  links to the previous hash, and stores `sha256(previous_hash || canonical row)`, where every field
  is length-prefixed. Triggers forbid update, delete and truncate; application roles also have no such
  privilege. The trigger is `SECURITY DEFINER` because it must read the previous hash across row
  security, so `audit_log` enables but does not force RLS (the owner runs the trigger; application
  roles are not the owner and stay bound by the policies).
- **Verification** is `audit_chain_first_bad()` (recomputes every hash and link) and
  `audit_chain_head()`, exposed as `pnpm audit:verify`. The chain alone cannot show that the newest
  rows were deleted, so the printed head must be kept outside the database and passed back with
  `--expect-head`. Shipping it to object storage with object lock waits for the worker (Stage 3).

## Alternatives considered
Security-definer functions for every login step: more places to get wrong than a narrow role.
A per-organization chain: more locks and no benefit at current volume. Forcing RLS on `audit_log`:
would blind the chain trigger.

## Consequences
The application must set the role and context in every transaction (slice 2 wires this into
`withRequestContext`). A table owner or superuser can still tamper by disabling triggers; the
external head anchor and restricted operator access are the controls for that.

## Verification
Mutation-checked: removing the advisory lock, granting `UPDATE` on the log, and making the users
read policy permissive each make a specific test fail. Tamper tests cover edit, middle delete, tail
truncation with an anchor, and a rewritten hash.

## Revisit trigger
More than about 200 audit events per second (serialized inserts), or the need for per-tenant
retention.

## Amendment (slice 2a): how the role is applied, and its limit
`withRequestContext` now takes a role and runs `set_config('role', <role>, true)` last in the
transaction, after checking it against the two allowed names (and binding it as a parameter). It
lasts for that transaction only. A test confirms the work runs as the requested role and that
nothing lingers on the pooled connection afterwards, including after a failure.

Known limit: `SET ROLE` is allowed to any role the login user belongs to, so an attacker who could
run arbitrary SQL inside a request could switch from `aura_app` to `aura_auth`. We prevent arbitrary
SQL by construction (tagged templates only, enforced by tigerlint and Semgrep), but the stronger
design is two login roles and two connection pools, one per group, so the database itself refuses
the switch. That is recorded as a hardening item for the security review before the first customer.
