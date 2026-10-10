# Stage 1 plan — Identity, tenancy, audit

Status: **approved by the founder on 2026-10-10**, with the defaults in sections 3 and 17 accepted
(their words: "use your defaults, Stage 1 plan approved"). Implementation may start with slice 0.
Kit reference: `docs/kit/12` Stage 1, `docs/kit/05` sections 5–7, `docs/kit/06`, `docs/kit/08` sections 3–5.

## 1. Goal
After this stage a person can sign in (passkey, email link, email code, GitHub, Google), hold safe
sessions, create and join organizations with roles, create API keys, and see their own security
settings. Every action that matters is audited in a tamper-evident log, and tenant isolation is
enforced both in code and by PostgreSQL row-level security (RLS), proven by generated tests.

## 2. Decisions already made (your answers, 2026-10-10)
| Topic | Decision |
|---|---|
| Auth approach | Thin in-house identity module on SimpleWebAuthn and Arctic, not Better Auth (ADR 0011) |
| Sign-in methods | Passkeys, email sign-in link, email one-time code, GitHub, Google |
| Organization creation | Open to everyone; new organizations are **unverified** with limited powers until a platform admin approves them. Everyone also gets a personal space |
| Email | `MailPort` plus a local mail catcher (Mailpit). The real provider is wired at deploy time |

## 3. Assumptions (tell me if any is wrong)
1. **No Drizzle yet.** Queries use `postgres.js` tagged templates in each module's `queries.ts`, with
   row results parsed by Zod at the boundary. SQL migrations stay the source of truth, and RLS is SQL
   anyway. Drizzle's typed builder adds a dependency and a second schema definition for little gain
   today; revisit at Stage 3 (ADR 0004 left this open).
2. **Two database roles for the API**: `aura_app` (tenant data, subject to RLS) and `aura_auth`
   (identity tables only, used for pre-login steps such as "find the user for this token"). Plus
   `aura_migrator` for migrations. Identity data is not tenant data, so a separate narrow role is
   easier to reason about than security-definer functions.
3. **Passkeys count as the second factor for privileged accounts** (user verification required, phishing
   resistant). TOTP is not built. Platform admins and organization owners and admins must have a passkey
   before privileged actions are allowed.
4. **Passkey settings**: attestation `none`, user verification `required`, resident keys preferred,
   challenges stored server-side, single-use, 5-minute lifetime.
5. **Account linking is never silent.** A GitHub or Google login that matches an existing email
   requires proving control of that account first (an existing session, or the email link/code).
   This closes the "pre-account takeover" class.
6. **Export and deletion** are limited: `GET /me/export` returns a bounded JSON document
   synchronously, and deletion marks the account (`deletion_requested_at`) and revokes sessions. The
   actual purge job needs the worker role (Stage 3) and is explicitly deferred.
7. **Rate limiting** uses an in-memory token bucket per instance for general classes and a PostgreSQL
   counter for the strict `auth` class. No Redis (kit trigger not met).
8. **Cloudflare Turnstile** is a `BotCheck` port with a no-op development implementation and a real
   verifier that stays off until keys exist; there is no Cloudflare account yet.
9. **A fake OAuth server in tests** stands in for GitHub and Google. Real sign-in with them needs
   OAuth apps that **you** create (section 12); the code path is identical.
10. **A minimal outbound HTTP client** (`platform/egress.ts`, host allowlist) is added because our own
    OAuth profile calls and Turnstile must not call `fetch` directly (Semgrep rule).

## 3b. New dependencies (each gets an ADR and a `deps.json` entry)
| Package | Where | Why | Notes |
|---|---|---|---|
| `@simplewebauthn/server` 14.x | api | WebAuthn verification | 3 advisories in 2026, fixed in 14.0.2; attestation `none` avoids the affected path |
| `@simplewebauthn/browser` | web | Browser side of passkeys | no dependencies |
| `arctic` 3.x | api | GitHub and Google OAuth flows | small, depends on `@oslojs/*` |
| `nodemailer` | api | SMTP to Mailpit now, a provider later | mature, no runtime dependencies |
| `@playwright/test` | dev | End-to-end tests with a virtual passkey authenticator and the first real-browser CSP check | |

Versions must satisfy the 3-day release-age rule at install time; any that do not are pinned one release lower.

## 4. Scope
**In:** identity tables, sessions, the five sign-in methods, organizations and memberships with roles,
platform admin role, API keys, `authorize()`, RLS on all tenant tables, audit log with hash chain,
rate limits for `auth`, `read`, `write`, the middleware slots `rateLimit`, `authenticate`, `csrf`,
`dbContext`, account and organization screens, Playwright end-to-end tests, threat model v1, ASVS
mapping, ADRs.

**Out:** SSO/SAML/SCIM, ID verification, TOTP, billing, the worker role and background jobs (so no
audit WORM shipping, export job or purge), self-hosted fonts and the full design system (plain
accessible markup only), tasks, judging, anything from later stages.

## 5. Data model (new migrations, expand-only, hand-written SQL)
All primary keys `uuid DEFAULT uuidv7()`; times `timestamptz`; every constraint is an assertion.

| Table | Purpose | RLS |
|---|---|---|
| `users` | id, email (citext, unique), `email_verified_at`, `status` (active, suspended), `platform_role` (none, admin), `deletion_requested_at` | by `app.user_id` |
| `profiles` | handle (citext unique), display name, visibility, locale | owner write; public columns readable by rule |
| `sessions` | token hash (sha256, unique), user, created, last_seen, idle and absolute expiry, ip hash, user-agent, `auth_method`, `revoked_at` | by `app.user_id` |
| `passkeys` | credential id (unique), public key, counter, transports, backup flags, name, last_used | by `app.user_id` |
| `oauth_identities` | provider, provider_user_id (unique together), user, email at link time | by `app.user_id` |
| `login_tokens` | purpose (`email_link`, `email_code`, `link_account`), token or code hash, email, expiry, `consumed_at`, attempts | `aura_auth` only |
| `webauthn_challenges` | challenge, purpose, user (nullable), expiry, `consumed_at` | `aura_auth` only |
| `orgs` | kind, slug, name, `verification_state` (unverified, verified), data_region | members only |
| `memberships` | (org, user) primary key, role | org members |
| `api_keys` | prefix, secret hash (sha256 of a 256-bit secret), scopes, expiry, revoked | org members with a role check |
| `audit_log` | append-only, hash chain (`prev_hash`, `hash`) | insert by app roles, no update, delete or truncate for anyone |
| `rate_limit_counters` | key hash, window start, count | `aura_auth` and `aura_app` |

Chain mechanics: a `BEFORE INSERT` trigger takes a transaction-level advisory lock, reads the previous
hash, and computes `sha256(prev_hash || canonical row text)`. Serialized inserts are fine at our
volume (auth and admin events, well under 50 per second). `UPDATE`, `DELETE` and `TRUNCATE` raise.
`pnpm audit:verify` recomputes the chain and fails on any difference.

Table ownership goes into ADR 0003 in the same pull request as each table.

## 6. API and contracts
New schemas in `@aura/contracts` (Zod `.strict()`, with limits): ids with prefixes (`usr_`, `org_`,
`ses_`, `key_`), sign-in requests and responses, organization and membership objects, API key objects.
Routes under `/api/v1`:
- `auth/email/start`, `auth/email/verify` (link and code), `auth/passkey/register/options|verify`,
  `auth/passkey/login/options|verify`, `auth/oauth/{github,google}/start|callback`,
  `auth/link/confirm`, `auth/logout`, `auth/logout-all`.
- `me`, `me/sessions` (list, revoke), `me/passkeys` (list, rename, delete), `me/export`, `me/delete-request`.
- `orgs` (create, list, get), `orgs/{id}/members` (invite, change role, remove), `orgs/{id}/api-keys`
  (create, list, revoke), platform-admin `admin/orgs/{id}:verify`.
Every route declares auth, permission, rate-limit class, idempotency decision, body limit and error
codes. Responses are explicit allowlists. A startup test asserts the middleware order.

## 7. Security design (key rules)
- **Sessions:** opaque 256-bit random token, only its SHA-256 stored; cookie `__Host-aura_session`
  (`Secure; HttpOnly; SameSite=Lax; Path=/`); idle timeout 30 min for admin and org owners/admins and 7
  days for others; absolute 30 days; rotation on sign-in and on privilege change; "log out everywhere".
- **Login tokens:** purpose-bound (a token for one purpose is rejected for another; the OAuth state
  can never be used as an email link), single-use through one atomic `UPDATE … WHERE consumed_at IS NULL
  AND expires_at > now() RETURNING`, link lifetime 10 minutes (shortened from 15 in slice 8 for ASVS V6.5.5), code 8 digits for 5 minutes (was 10) with at most
  5 attempts, constant-time comparison, and the link or code is bound to the browser that requested it by a
  short-lived cookie. Responses and timing do not reveal whether an email exists.
- **OAuth:** `state` plus PKCE, exact redirect-URI allowlist, provider-verified email required,
  linking rules as in assumption 5. GitHub's primary verified email is read through the egress client.
- **CSRF:** `Origin` and `Sec-Fetch-Site` checks plus a custom header on unsafe methods.
- **Authorization:** `authorize(actor, action, resource)` is deny-by-default and also enforced in the
  database: `withRequestContext` sets the actor, user and organization list per transaction. A route
  without an authorization-matrix row fails CI.
- **Pre-auth data access** uses the `aura_auth` role, which cannot read tenant tables.
- **Secrets and logs:** no tokens, codes or emails in logs (email is hashed for log correlation).
  The redaction list gains `code`, `token` and `otp`. Rate limits as in kit file 06 section 8.
- **Assertions vs. input validation:** externally reachable input is validated and returns a typed
  error; invariants (impossible internal states) assert. Attackers must not be able to trigger an
  assertion and thereby restart the process (a risk recorded in the Stage 0 report).

## 8. Invariants (each asserted in code and covered by a test)
1. A session token is shown once and only its hash is stored.
2. A login token is consumed at most once and only for its own purpose and email.
3. A user has at most one verified email; `email_verified_at` is set only through a consumed login
   token or a provider-verified email.
4. An organization always has at least one owner.
5. A user can never read or write a row of an organization they are not a member of, at either layer.
6. The audit chain is append-only and recomputes exactly; any change is detected.
7. A privileged action (admin, owner or admin role changes, API key creation, org verification) requires
   a session created with a passkey in the last 15 minutes, or a fresh passkey step-up.
8. An unverified organization cannot have capabilities that need verification (flag checked by
   `authorize`; the capabilities themselves arrive in later stages).

## 9. Limits (named constants with units and reasons, in `limits.ts`)
Email 254 bytes; handle 3 to 24; display name 80; org name 120; passkeys per user 20; active sessions
per user 20 (the oldest is revoked); organizations per user 20; members per org 5,000; API keys per org
20; login tokens per email per hour 5; OTP attempts 5; OAuth callbacks per IP per minute 10; request
body 256 KiB; pagination default 25, maximum 100.

## 10. Back-of-envelope
Session lookup is one indexed read per request: about 0.3 ms, so 1,000 requests per second is 1,000
queries per second on a small instance, trivial. The bottleneck at this stage is not a resource; we
therefore add **no session cache** (a cache would delay revocation). The audit chain serializes
inserts at roughly 1 to 2 ms each, a ceiling of a few hundred events per second, far above need.
Revisit triggers: session reads above 5,000 per second, or audit events above 200 per second.

## 11. Work breakdown (small vertical slices, tests first, one PR each)
| # | Slice | Verify |
|---|---|---|
| 0 | ADRs for dependencies; install and pin packages; `limits.ts`; contracts for ids and auth | `pnpm check`, depcheck |
| 1 | Migration: roles, users, profiles, audit log with hash chain and tamper test; `pnpm audit:verify` | chain tamper test fails when a row is edited |
| 2 | Sessions: create, validate, rotate, revoke; cookie; pipeline slots `authenticate`, `csrf`, `dbContext`; session DST scenario | DST (100k seeds nightly), fixation and rotation tests |
| 3 | `MailPort` + Mailpit; email link and code login; enumeration-safe responses; `auth` rate limit | timing and enumeration tests, token purpose and replay tests, DST for token state |
| 4 | Passkeys: register and login, challenge table, device list | Playwright with a virtual authenticator |
| 5 | OAuth: GitHub and Google through a fake provider; safe linking; egress client | pre-account-takeover tests, state and PKCE tests |
| 6 | Orgs, memberships, roles, `authorize()`, API keys, org verification by platform admin | generated RLS matrix and authorization matrix |
| 7 | Account and organization screens (plain accessible markup), `me/export`, delete request | Playwright journeys, axe, first browser CSP check |
| 8 | Hardening: threat model v1, ASVS mapping, runbook for session revocation, stage report | security gate checklist |

## 12. Things only you can provide, and when
- **Before slice 5 can run for real (not for tests):** a GitHub OAuth App and a Google Cloud OAuth
  client, with the redirect URI `http://localhost:3000/api/v1/auth/oauth/<provider>/callback` for
  development. Client IDs and secrets go in your local `.env`, never in the repository.
- **Before the first deploy:** the staging decisions (D1, D3, D8) and a real email provider.
- **At the end of the stage:** your sign-off. The kit also wants a human read of identity, database
  and RLS diffs; the pull request for each slice is where that happens.
- **Kept current in `docs/stages/stage-1-report.md`, section "Your remaining manual tasks"** (a checklist
  with the exact steps). This section is the original forecast; the report is the live list.

## 13. Failure modes and tests (summary)
Database down during login (typed 503, nothing half-created); expired, reused, wrong-purpose and
wrong-browser tokens; code brute force (lock after 5); passkey replay and counter regression;
passkey challenge reuse; OAuth state tampering, redirect mismatch, unverified provider email,
existing-email collision; session theft indicators (IP change is recorded, not an auto-block);
concurrent logins past the session limit; two simultaneous org-owner removals (last-owner rule);
audit log insert under concurrency; RLS bypass attempts through every tenant table and operation;
API key shown once and unusable after revocation; rate limits at the boundary (limit minus one,
limit, limit plus one).

## 14. Threat model additions (STRIDE highlights)
Spoofing: account takeover via email link, OAuth linking, passkey enrollment. Tampering: audit log,
session cookie. Repudiation: audit chain. Information disclosure: enumeration, tenant data, tokens
in logs. Denial of service: login flooding and lockout abuse (soft lockout through step-up, not hard
lock). Elevation: org role changes, platform admin, API key scopes. The full table lands in
`docs/threat-model.md` v1 with slice 8.

## 15. Observability
Structured auth events (no personal data: hashed email, user id, method, result, request id) in
logs and in the audit log for security-relevant actions. OpenTelemetry stays deferred to the first
multi-service flow. Alert-ready counters (failed logins, token reuse, RLS denials) are logged now
and become metrics when the metrics stack exists.

## 16. Rollout and rollback
No production exists. Migrations are expand-only and additive, so a revert of any slice leaves the
database valid. Each slice merges only with green CI, and the stage report records evidence.

## 17. Open questions, answered on 2026-10-10 (defaults accepted)
1. Email code format: **8-digit numeric**, 10-minute lifetime, 5 attempts.
2. Passkey requirement: **all organization owners and admins**, and platform admins, as in assumption 3.
3. Organization creation: **rate-limited to 5 per day per user** while the organization is unverified.
4. Account purge job: **deferred to Stage 3** with the worker role; Stage 1 records the deletion request only.

## 18. Implementation log
- **Slice 0 (2026-10-10), as built.** Narrowed from the table in section 11: dependencies are installed
  in the slice that first uses them (an unused dependency fails `depcheck`), so this slice delivers
  only the shared building blocks: prefixed UUIDv7 ids, identity limits, and input schemas for
  email, handle, organization slug, names and roles (`@aura/contracts/ids`, `identity`, `limits`),
  with boundary tests. The roles that exist in Stage 1 are `owner`, `admin`, `member`. While doing
  this, Biome's formatter turned a regular expression's escapes into raw invisible characters, so a
  new `tigerlint` rule (`no-hidden-characters`, the "Trojan Source" class) now fails the build if
  any TypeScript file contains raw zero-width, direction-control or byte-order-mark characters, and
  the name check uses explicit code point ranges instead of a regular expression.
- **Slice 1 (2026-10-10), as built.** Migrations 0002 to 0004: the two group roles, `users`,
  `profiles`, and the hash-chained `audit_log` with verification (`pnpm audit:verify`), plus the
  generated RLS coverage test and ADR 0012. `withRequestContext` does not yet switch role; slice 2
  does that with the sessions work. Writing the tests exposed a Stage 0 bug: `pnpm db:migrate` hung
  with its single-connection pool, because the runner held the one connection for its lock and then
  waited for another. The runner now does the migration transaction on the locked connection, with a
  regression test.
- **Slice 2a (2026-10-10), as built.** Session core, database side. The plan's slice 2 was split into
  2a (this) and 2b (HTTP: cookie, CSRF, the `authenticate`, `csrf`, `dbContext` middleware, the
  `/me` and logout routes). In 2a: `withRequestContext` now switches to the requested database
  role (ADR 0012 amendment); migration 0005 `sessions` (token hash only, revoke-once trigger,
  column-level grants that hide the hash from `aura_app`); `Rng.nextBytes` and a pure `makeUuidV7`;
  the pure session rules; the service over a `SessionStore` port with an in-memory implementation
  and a PostgreSQL one; and a test that runs identical random operations against both and requires
  identical results. The session store records a coarse network and user agent instead of the
  planned IP hash. The deterministic simulation (now asynchronous) drives the service against an
  independent model and found a real bug: rotating a session while at the 20-session cap evicted an
  unrelated session, because the new session was created before the old one was revoked. Fixed
  (revoke first) with a regression test; the simulation also exposed three blind spots in itself,
  which the mutation checks (idle boundary, eviction off by one, touch every time, rotation order)
  now catch.
- **Slice 2b-i (2026-10-10), as built.** The plan's slice 2 was split a second time: 2b-i is the pure
  transport rules, 2b-ii the middleware, routes and API-level tests. 2b-i adds: `AURA_PUBLIC_ORIGIN`
  (required, bare origin, https outside local and test); the session cookie format and strict
  parsing (duplicates and oversized headers refused); and the CSRF decision table (ADR 0013). The
  CSRF check applies to every state-changing request, not only cookie-authenticated ones.
- **Slice 2b-ii (2026-10-10), as built.** The HTTP side of sessions. The `authenticate`, `csrf` and
  `dbContext` middleware run, in the order `pipeline.ts` asserts, for everything under `/api/v1`;
  `dbContext` gives each request one transaction as `aura_app` and rolls it back for any response
  with status 400 or above. Routes: `GET /me`, `GET /me/sessions`, `DELETE /me/sessions/{id}`,
  `POST /auth/logout` (idempotent, clears a stale cookie) and `POST /auth/logout-all`. Responses go
  through strict allowlist schemas in `@aura/contracts/api/identity`; the device list reads only the
  columns `aura_app` may see, so token hashes never leave the database. Each action writes one audit
  entry in the same transaction. An id from the outside is parsed with a safe parser, never an
  assertion, so malformed input answers 400 and cannot ask the process to stop. The authorization
  matrix is generated from the app's real route table: a route without a declared row, or a row for
  a missing route, fails CI. Two Semgrep false positives (typed and call-expression SQL tags)
  surfaced and were fixed with tests.
- **Slice 3a (2026-10-10), as built.** The foundations of email sign-in, with no route yet (3b adds
  those). Config: `AURA_MAIL_DRIVER`, `AURA_MAIL_API_URL`, `AURA_MAIL_FROM`, `AURA_LOGIN_TOKEN_SECRET`.
  Platform: a fixed-origin egress client, a mail port (Mailpit, disabled and in-memory drivers) and a
  fixed-window rate limiter over PostgreSQL. Migration 0006 adds `login_challenges` (plan name
  adjusted from "email_login_tokens"; one expiry per method instead of one per row) and
  `rate_limit_counters`. The challenge store has memory and PostgreSQL implementations proven
  equivalent, and a `login` simulation whose five injected faults (attempt limit, reusable link,
  immortal code, uncounted guesses, ignored binding) are all caught. Differences from the plan: the
  token-hash timing test became a structural-equality check (wall-clock timing is flaky in CI), and
  the mail port is HTTP only (ADR 0014).
- **Slice 3b (2026-10-10), as built.** Email sign-in works end to end: `POST /auth/email/start` and
  `POST /auth/email/verify` (link token or typed code), account and default profile created on first
  sign-in (handle `user_` plus 10 hex digits, never derived from the email), session started with a
  coarse network and user agent, previous session of that browser ended, audit entries
  (`auth.signup`, `auth.login_succeeded`, `auth.login_refused`, `auth.code_locked`). The `rateLimit`
  middleware slot is now used. Mutation checks on the HTTP tests (stale-cookie handling, old session
  kept, both rate limits, lock audit, suspended people, new-account flag, binding cookie clearing)
  were all caught. Not done here and deliberately so: the web pages that call these endpoints
  (slice 7), and a production mail provider (ADR 0014 revisit trigger).
- **Slice 4 (2026-10-10), as built.** Passkeys. Migration 0007 adds `passkeys` and
  `webauthn_challenges`; routes `POST /auth/passkey/register/options|verify`,
  `POST /auth/passkey/login/options|verify`, and `GET|PATCH|DELETE /me/passkeys`. New dependency
  `@simplewebauthn/server` 14.0.3 (ADR 0015). The shared tail of every sign-in (end the old session,
  start the new one, audit) moved into `issueLoginSession`. Differences from the plan: **Playwright
  and `@simplewebauthn/browser` move to slice 7**, because there are no pages to drive yet; the
  server side is tested with a software authenticator that makes real signatures instead. Step-up
  (a fresh passkey check for a session that already exists) is built in slice 6 with the first
  privileged action, which is where it is needed. Sessions created by passkey are not yet marked
  privileged for platform admins; that arrives with roles in slice 6, for all methods at once.
- **Slice 5 (2026-10-10), as built.** Sign-in with GitHub and Google. Migration 0008
  (`oauth_identities`, `oauth_flows`); routes `POST /auth/oauth/{provider}/start`,
  `GET /auth/oauth/{provider}/callback`, `GET /me/identities`, `DELETE /me/identities/{provider}`;
  config for client id and secret per provider (off unless both are set). **Arctic was not used**: it
  calls `fetch` directly and has fixed endpoints, which conflicts with the egress-only rule and with
  testing against a fake provider, so the small flow is written on the egress client (ADR 0016); no
  new dependency. Linking rules as planned: a new identity creates an account only with a
  provider-verified email nobody uses; otherwise nothing is linked; connecting a provider needs a
  signed-in session. Not exercised against the real providers: that needs the OAuth apps you create
  (section 12). The plan's `login_tokens` `link_account` purpose was not needed because linking uses
  the existing session instead of an email proof.
- **Slice 6a (2026-10-10), as built.** Slice 6 was split in three: 6a (this) organizations,
  memberships, roles, `authorize()`; 6b API keys, privileged sessions with passkey step-up, org
  verification by a platform admin; 6c invitations. 6a: migration 0009 (`orgs`, `memberships`,
  `create_org`, role helper functions, last-owner and 20-organization rules as database triggers,
  personal-space slug reserved, backfill for existing people), personal space at sign-up, routes
  `POST|GET /orgs`, `GET|PATCH /orgs/{id}`, `GET /orgs/{id}/members`, `PATCH|DELETE
  /orgs/{id}/members/{userId}`, the actor now carries memberships and `dbContext` passes the
  organization ids to PostgreSQL. ADR 0017. Two simultaneous owner departures resolve to exactly
  one success at both the database and HTTP level. Invitations were pulled out of this slice because
  they need their own table, email and acceptance flow.
- **Slice 6b (2026-10-10), as built.** API keys, privileged sessions, passkey step-up and
  organization verification. Migration 0010 (`api_keys`, step-up challenge purpose, `verify_org`,
  key-read policy on organizations). Routes: `POST|GET /orgs/{id}/api-keys`,
  `DELETE /orgs/{id}/api-keys/{keyId}`, `GET /key`, `POST /auth/passkey/step-up/options|verify`,
  `POST /admin/orgs/{id}/verify`. New error code `step_up_required`. Bearer authentication with the
  CSRF exception for keys (ADR 0018, closing the promise in ADR 0013). Differences from the plan: the
  only scope is `org:read` (nothing else exists to guard yet); the stricter idle limit is set at
  sign-in and on promotion, not recomputed every request (recorded in ADR 0018 and left for slice 8);
  invitations are slice 6c.
- **Slice 6c (2026-10-10), as built.** Invitations. Migration 0011 (`org_invitations`; a personal
  space never gets a second member; 5,000-member cap). Routes `POST|GET /orgs/{id}/invitations`,
  `DELETE /orgs/{id}/invitations/{invitationId}`, `POST /invitations/accept`; new id prefix `inv`.
  ADR 0019. This completes slice 6: organizations, memberships and roles with `authorize()`,
  API keys, passkey step-up, privileged sessions, platform-admin verification and invitations.
  Not done, deliberately: capabilities that need a verified organization do not exist yet, so the
  `authorize` hook for them (Stage 1 invariant 8) has nothing to guard; the flag is stored and shown.
- **Slice 7a (2026-10-10), as built.** Slice 7 was split: 7a (this) the foundation, the account screens
  and the end-to-end setup; 7b the organization screens. 7a adds API routes `GET /auth/methods`,
  `GET /me/export` (bounded JSON download, audited), `POST|DELETE /me/delete-request` (marks the
  account, ends every session, can be cancelled by signing in again; the purge is Stage 3), and
  `deletion_requested_at` in `/me`. Web: sign-in (passkey, email code and link, OAuth buttons for
  configured providers), link landing page, OAuth result page, and the account page (profile,
  passkeys, connected accounts, devices, export, deletion). New `apps/e2e` workspace with Playwright
  and axe, a runner that starts everything (`pnpm test:e2e`), and a CI step. ADR 0020 records the
  dependencies and the real problems the browser found: low button contrast, Zod's `eval` probe
  blocked by the CSP, and a hydration mismatch on passkey support; all fixed.
- **Slice 7b (2026-10-10), as built.** The organization screens, completing slice 7: the organization
  list and creation form, the organization page (rename, members with role changes and removal,
  invitations, API keys with the key shown once), and the invitation landing page. Privileged actions
  go through a helper that asks for a passkey check and retries once; a person with no passkey is told
  to add one. Five more browser tests (19 in all), axe-clean on every page. Not built, deliberately:
  platform-administrator screens (verification is an API route for now; the platform-admin procedure
  goes into the slice 8 runbook), and a "next" address after sign-in (an invitation link opened while
  signed out asks the person to sign in and open the link again).
- **Slice 8 (2026-10-10), as built.** Hardening. Mapped ASVS 5.0 V6, V7 and V8 (79 requirements) against
  the official list; closed the gaps worth closing (ADR 0021): link 10 minutes and code 5 (V6.5.5), the
  stricter idle limit applied on every request (V8.3.2), a fresh passkey check to remove a passkey or
  disconnect a provider (V7.5.1), a platform-admin route to end a person's sessions (V7.4.5), sign-out
  on every page (V7.4.4). Added the account-takeover drill and the no-secrets-in-logs test, a nightly
  100,000-seed simulation workflow, threat model v1, the authentication reference, the identity runbook,
  the cutlist and the stage report. Not done: the human reads (diffs, ASVS sign-off) and the open
  items in `docs/cutlist.md`.
- **Follow-ups after slice 8 (2026-10-10).** Cutlist F4 and F14 done: ending other devices or all sessions
  needs a fresh passkey check from anyone who holds a passkey (new `POST /me/sessions/revoke-others`);
  after removing a passkey or disconnecting a provider the page offers "Sign out my other devices";
  sign-in follows a `?next=` page chosen from an allowlist of our own pages, and an invitation link opened while signed out goes through
  sign-in and joins. ASVS V7.4.3 and V7.5.2 are now met (49 met, 3 partial, 4 not met).
