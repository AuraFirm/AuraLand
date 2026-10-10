# 0017 — Organizations, roles and tenant isolation
Status: accepted
Date: 2026-10-10

## Context
Organizations are the first tenant data and the unit of isolation for everything built later
(tasks, contests, credentials). The rule from the security spec is that a person can never read or
write a row of an organization they do not belong to, in application code and in PostgreSQL.

## Decision
- **Tables:** `orgs` (kind, unique slug, name, verification state, data region) and `memberships`
  (organization, person, role). Roles: `owner` (everything), `admin` (rename, remove plain members),
  `member` (read, leave). Changing roles is owner-only. Every person gets a **personal space** at
  sign-up (kind `personal`, slug `p-` plus ten hex digits, which the database reserves for personal
  spaces so nobody can take one); existing accounts were backfilled by the migration.
- **Two layers, same rules.** `authorize(subject, action)` is a pure, deny-by-default table
  (`authorize.ts`) used by the routes; the same rules are policies in PostgreSQL, written with two
  SECURITY DEFINER helpers (`app_org_role`, `app_shares_org`) that read the caller's role from the
  transaction's `app.user_id`. A mistake in one layer is caught by the other. A person outside an
  organization gets 404, never 403, so existence is not revealed.
- **Not forced RLS on these two tables**, like `audit_log`: the helpers run as the table owner and
  must read memberships; application roles are not the owner and stay bound by the policies.
- **No direct inserts.** `aura_app` cannot insert organizations or memberships. `create_org()` is
  the only way to make a team, and it makes the caller its first owner in the same statement.
- **Database rules, not only code:** an organization always has at least one owner (a trigger with
  a per-organization lock, so two simultaneous departures cannot empty it); a person belongs to at
  most 20 organizations (trigger with a per-person lock); a coworker's profile (handle, display
  name) is visible to people who share an organization, nothing else is.
- **Request context.** `authenticate` loads the person's memberships once per request and puts them
  in the actor; `dbContext` passes the organization ids to PostgreSQL (`app.org_ids`), which the audit
  policy already reads. Roles used in policies come from the database, not from that list, so a
  membership removed mid-request cannot be used.
- **Creation limit:** five organizations per person per day while organizations are unverified,
  counted with the rate-limit table, plus the 20-organization cap.
- **Audit:** `org.created`, `org.updated`, `org.member_role_changed`, `org.member_removed`,
  `org.member_left`, each with the organization id so members can read their own organization's trail.

## Alternatives considered
A separate module for organizations (the kit keeps them in `identity`; one module avoids a premature
split). RLS from a roles list in a setting (stale if a membership changes mid-request). Letting
`aura_app` insert memberships with a policy (hard to express "first owner" safely; a function is simpler).

## Consequences
Org-scoped tables added later follow the pattern: `org_id`, a policy using `app_org_role(org_id)`, and
a row in the RLS and authorization matrices. Invitations, API keys, step-up and org verification build
on this in the next slices.

## Verification
`orgs.test.ts` (18 database cases incl. last-owner and cap races, six migration mutations caught),
`authorize.test.ts` (the full table), `http-orgs.test.ts` and the generated authorization matrix.

## Revisit trigger
A need for per-resource sharing across organizations, custom roles, or more than ~100 memberships per person.
