# 0003 — Table ownership
Status: accepted
Date: 2026-10-10

## Context
docs/kit/04: a module's tables are written only by that module, and other modules reach its data
through its `service.ts`.

## Decision
This file is the ownership map. Add a row in the same pull request that creates a table.

| Table | Owner | Notes |
|---|---|---|
| `schema_migrations` | `packages/db` (`migrate.ts`) | Migration ledger with SHA-256 checksums; written only by the migration runner |
| `users` | `modules/identity` | Person accounts; created and updated by the identity role, self-readable by `aura_app` |
| `profiles` | `modules/identity` | Handle, display name, visibility; owner-editable |
| `sessions` | `modules/identity` | Login sessions (token hashes only); created by the identity role, listable and revocable by their owner |
| `login_challenges` | `modules/identity` | Email sign-in challenges (HMAC hashes only); identity role only, invisible to `aura_app` |
| `passkeys` | `modules/identity` | WebAuthn public keys; owner may list, rename and delete (never read the key or counter); identity role verifies and records use |
| `webauthn_challenges` | `modules/identity` | One-time passkey challenges (5 minutes); identity role only |
| `oauth_identities` | `modules/identity` | Links a person to a GitHub or Google identity (provider id, not email); owner may list and unlink, identity role creates |
| `oauth_flows` | `modules/identity` | One-time records of OAuth sign-ins in flight (HMAC hashes only); identity role only |
| `orgs` | `modules/identity` | Organizations (personal space per person, plus teams); members read, owners and admins rename; created only through `create_org` |
| `memberships` | `modules/identity` | Who belongs to which organization, with a role; members read, owners change roles, removal per role; always keeps one owner |
| `rate_limit_counters` | `platform` (`rate-limit.ts`) | Fixed-window counters for the strict rate-limit class; identity role only |
| `audit_log` | `packages/db` (`audit.ts`), written through `appendAudit` by any module | Append-only hash chain; readable by org members and by the actor |

The RLS matrix test (`packages/db/src/rls-matrix.test.ts`) fails when a table is missing from this list or lacks row-level security.

## Consequences
CI will gain a check that every table in the schema appears here (Stage 1, with the first tables).

## Revisit trigger
Module split into services.
