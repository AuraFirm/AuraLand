# 0011 — In-house identity on SimpleWebAuthn instead of Better Auth
Status: accepted (founder choice, 2026-10-10)
Date: 2026-10-10   Deciders: founder; verified by Claude

## Context
The kit (file 03) chose Better Auth ⚠️VERIFY. Verification on 2026-10-10 found:
- Better Auth 1.7.7 (2026-09-30) is current. Its GitHub advisory feed lists **27 advisories published
  in 2026: 3 critical, 17 high**. Examples: OAuth state usable as a magic link to sign in as another
  user (critical, fixed in 1.7.7 on 2026-09-30, ten days ago); OAuth proxy sign-in as another user
  (high, 1.7.7); a password that keeps working after magic-link or email-code sign-in (high, 1.6.22);
  SCIM token takeover (critical, 1.6.22); several SSO takeovers. Most are in plugins we would not
  enable, but the core magic-link and OAuth paths are among them.
- It brings its own database layer (Kysely or Drizzle adapter, a `pg` pool as peer dependency), its
  own tables and schema generator, and generated IDs, which clash with our hand-reviewed SQL
  migrations, uuidv7 keys, `postgres.js` client and transaction-local row-level security context.
- Its passkey plugin is built on SimpleWebAuthn, the same library we would use directly.
- Our needs in Stage 1 are small: passkeys, email links and codes, GitHub and Google login,
  DB-backed sessions, organizations and API keys. Enterprise SSO and SCIM are Stage 9 and would come
  from a vendor behind an `AuthPort`.

## Decision
Build a thin identity module in `apps/api/src/modules/identity` using:
- `@simplewebauthn/server` and `@simplewebauthn/browser` for WebAuthn. SimpleWebAuthn had 3
  advisories in 2026 (2 medium, 1 low; the medium ones concern attestation certificate handling and
  were fixed in 14.0.2). We use attestation type `none`, which avoids that code path, and pin
  14.0.3 or newer.
- `arctic` for the GitHub and Google OAuth authorization-code flows (no published advisories).
- Our own sessions, login tokens and account-linking rules, written to the kit's security spec
  (opaque 256-bit tokens stored hashed, single-use purpose-bound tokens, no silent account linking).

## Alternatives considered
Better Auth with minimal plugins: faster start, but the advisory record, the extra database layer
and the schema clash outweigh it. A hosted vendor now (WorkOS, Clerk): identity data would leave
our database, which fights row-level security and the audit log, and adds per-user cost.

## Consequences
We own security-critical code. Mitigations: small surface, every rule written as a test first,
authorization and row-level-security matrix tests, deterministic simulation of token and session
state machines, Semgrep and CodeQL on every push, and an external review before the first
customer. Enterprise SSO later is bought, not built.

## Verification
Plan and tests are in `docs/stages/stage-1-plan.md`. The kit files stay unchanged; this ADR
supersedes the Better Auth line in kit file 03.

## Revisit trigger
Needing SAML, SCIM or social providers beyond GitHub and Google; or an advisory in SimpleWebAuthn
or Arctic that we cannot fix by upgrading.
