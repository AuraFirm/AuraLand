# Threat model (v1, Stage 1)

Updated every stage (docs/kit/08 section 14). v0 covered the shell, the build pipeline and the
database context pattern; those rows are kept at the end. v1 adds identity, tenancy and the browser.

## Assets
1. **Accounts and the ability to act as someone**: sessions, passkeys, sign-in secrets, API keys.
2. **Tenant data isolation**: organizations, memberships, and everything later stages attach to them.
3. **Integrity of the audit trail**: who did what, when.
4. **Personal data**: email addresses, device and network hints, the export and deletion promises.
5. **Availability of sign-in** and of the outbound services it needs (mail, GitHub, Google).
6. **Secrets**: the login-token key (`AURA_LOGIN_TOKEN_SECRET`), OAuth client secrets, database credentials.

## Actors
Anonymous visitor; ordinary signed-in person; organization member, admin, owner; holder of an API
key; platform administrator; an attacker who controls a mailbox, a browser extension, another website
the victim visits, a network position, or a leaked database dump; a malicious insider with database
read access; a compromised dependency.

## Trust boundaries
1. Internet → edge (not built) → **web** (Next.js, renders UI, decides nothing) → **API** (all decisions).
2. API → **PostgreSQL**, as one of two roles: `aura_auth` (identity work before or around login) and
   `aura_app` (everything on behalf of a person, bound by row-level security). The database is a
   second decision point, not a store.
3. API → **mail service**, **GitHub**, **Google** through the egress client only (fixed origins,
   no redirects, timeouts, size caps).
4. Browser → API: same origin, cookie plus a custom header on writes.
5. Machine → API: bearer API key, no cookie.

## STRIDE for the Stage 1 surface
| Threat | Surface | Control | Evidence |
|---|---|---|---|
| **Spoofing**: take over an account through the email route | Sign-in link and code | 256-bit link, 8-digit code with 5 guesses, 10 and 5 minute lives, single use, bound to the requesting browser, keyed-hash storage | `http-sign-in.test.ts`, `http-red-team.test.ts`, `login` simulation |
| Spoofing: pre-account takeover with a provider | OAuth sign-in | Identity is the provider's id; only a provider-verified email may create an account; an existing email is never linked silently; linking needs a signed-in session | `http-oauth.test.ts` (22 cases), ADR 0016 |
| Spoofing: phishing the second factor | Passkeys | Origin and relying-party id checked by the browser and the server; user verification required; counter regression refused | `http-passkeys.test.ts` (wrong origin, wrong key, replay, regression) |
| Spoofing: forge or replay a session | Session cookie | 256-bit random token, hash stored, `__Host-` cookie, HttpOnly, SameSite=Lax; new token on every sign-in | `http-sessions.test.ts`, `sessions` simulation |
| Spoofing: login CSRF / state fixation | OAuth and email flows | State plus PKCE bound to a cookie; callback needs both; email proof bound to the browser | `http-oauth.test.ts`, `http-sign-in.test.ts` |
| **Tampering**: cross-site request forgery | All writes | Custom header, exact Origin, `Sec-Fetch-Site`; API keys exempt because they carry no ambient credential | `http-sessions.test.ts`, matrix CSRF rows, ADR 0013, ADR 0018 |
| Tampering: change another organization's data | Organizations, members, keys, invitations | `authorize()` plus row-level security using the caller's role read in the database; outsiders get 404 | `orgs.test.ts`, `api-keys.test.ts`, `invitations.test.ts`, `authz-matrix.test.ts` |
| Tampering: promote oneself or remove the last owner | Memberships | Role changes owner-only; no direct inserts for the app role; last-owner and cap rules are locked database triggers | `orgs.test.ts` (races included) |
| Tampering: edit or delete audit history | `audit_log` | Append-only triggers, hash chain, `pnpm audit:verify`; chain head must also be kept outside the database (open, F8) | `audit.test.ts`, `http-*.test.ts` chain checks |
| **Repudiation**: deny an action | Audit log | Sign-ins, signups, factor changes, role changes, key and invitation actions, admin actions, exports and deletion requests are audited with actor, target and (hashed) context, in the same transaction | per-route tests count audit rows |
| **Information disclosure**: learn who has an account | Sign-in start and verify, OAuth, invitations | Start never looks the address up; one generic failure answer; invitations name an address and do no lookup | `http-sign-in.test.ts`, `http-invites.test.ts` |
| Disclosure: secrets in logs | Everything that logs | No secret reaches a log line even with redaction off; redaction list as a second net | `http-log-hygiene.test.ts`, `log.test.ts` |
| Disclosure: secrets from a database dump | Token, key and secret columns | Only hashes (HMAC under a key kept outside the database, or SHA-256 of 256-bit secrets); the app role has no column privilege on them | `login.test.ts`, `passkeys.test.ts`, `api-keys.test.ts`, `invitations.test.ts` |
| Disclosure: data of other tenants | Every tenant table | RLS enabled and forced (two documented exceptions), generated coverage test, two-organization tests | `rls-matrix.test.ts`, `orgs.test.ts` |
| Disclosure: leakage through responses | API output | Strict allowlist schemas; secrets are not in any schema | schema tests, export test |
| Disclosure: injected script steals a session | Web | Nonce CSP with `strict-dynamic`, no eval, HttpOnly cookie, strict headers; the browser is tested to block an inline handler | `pages.spec.ts` (end to end), `csp.test.ts` |
| Tampering: send someone to another site after sign-in (open redirect) | `?next=` on the sign-in page | The value is looked up in a short list of our own pages and our copy is returned; anything not on the list falls back to the account page. (CodeQL flagged a filter-style check as an unvalidated redirect, so the check was rewritten as a lookup.) | `next-path.test.ts`, `sign-in.spec.ts` |
| Disclosure: invitation secret kept during sign-in | Invitation link opened while signed out | Held in this tab's session storage for one sign-in and removed when read; one-time, tied to one verified email | `orgs.spec.ts`, ADR 0019 |
| **Denial of service**: flood sign-in or email | Anonymous endpoints | Per-address, per-email and per-organization limits, body cap, timeouts; flood drill shows the numbers | `http-red-team.test.ts` |
| DoS: lock a victim out | Code guessing | Locks one challenge, not the account; the victim requests a new one; per-email limit caps inbox flooding at 5 an hour | `http-red-team.test.ts` |
| DoS: provider or mail outage | GitHub, Google, mail | Typed 503 or redirect reason, nothing half-saved, other sign-in methods keep working | `http-sign-in.test.ts`, `http-oauth.test.ts`, `http-invites.test.ts` |
| **Elevation**: use a stale or stolen session for a powerful action | Privileged actions | Passkey check in the last 15 minutes; people who hold power get a 30-minute idle limit on every request; promotion ends the person's other sessions | `http-keys.test.ts` |
| Elevation: API key abuse | Machine access | Org-scoped, `org:read` only, expiring, revocable, 20 per organization, hashed; cannot reach routes meant for people | `http-keys.test.ts` |
| Elevation: becoming a platform administrator | Admin routes | No sign-up path; set by an operator in SQL; routes answer 404 to others and need a fresh passkey check; the database function checks the role again | `http-keys.test.ts`, `api-keys.test.ts` |
| Elevation through a library | SimpleWebAuthn, Next.js, Zod | Exact pins, 3-day release age, `pnpm audit`, attestation `none` (avoids the advisory path), thin renderer rules | ADR 0005, ADR 0015, CI |
| Supply chain | Dependencies, CI | As v0, plus Playwright and axe confined to a test-only workspace | `deps.json`, `depcheck` |
| SSRF through OAuth or mail | Outbound calls | Fixed origins from configuration, redirects refused, response caps; the redirect URI is computed, never read from a request | `egress.test.ts`, `oauth-providers.test.ts` |
| Insecure patterns entering the code | Whole repo | Semgrep project rules, tigerlint, CodeQL; two CodeQL alerts on hashing high-entropy secrets: one avoided by renaming a helper, one dismissed with a written reason (alert 3, ADR 0018) | CI |

## Abuse cases drilled (`http-red-team.test.ts`)
Credential stuffing from one machine (10 emails a minute at most); a botnet against one victim (5
emails an hour at most); a leaked binding cookie (5 guesses in total, from any number of addresses);
guessing proofs without a challenge (30 a minute, none touching real state); flooding the passkey
challenge table (30 rows a minute per address); probing API keys (same answer for a wrong prefix and a
wrong secret).

## Privacy review (Stage 1)
Collected: email address; handle and display name (defaults to a random handle, never derived from the
email); coarse network (/24 or /48) and browser string per session; provider id and the provider-verified
email at link time; passkey public keys and names; audit entries about the person's own actions.
Not collected: IP addresses beyond the coarse network and the audit `ip` of security events, phone
numbers, contacts, analytics. Rights: the person can download their data (`/me/export`), end any
session, remove passkeys and connected accounts, and request deletion (recorded, sessions ended, the
purge itself arrives with the worker in Stage 3). Retention is not yet automated: sessions, challenges,
flows and rate-limit rows are cleaned by the Stage 3 worker (F9).

## Rollback and feature flags
Migrations 0001 to 0011 are additive. Reverting a slice leaves a valid database: unused tables and
columns are ignored by older code. OAuth providers and email are switched on by configuration, so any
sign-in method can be turned off without a deploy of code. There are no feature flags beyond that.

## Known gaps (accepted for Stage 1, ranked in `docs/cutlist.md`)
No TLS termination, WAF or CDN (edge not built). No external anchor for the audit chain head. No
cleanup job for expired rows. No production mail provider, so email sign-in is off in production. No
notifications after security changes. OAuth has not been exercised against the real providers. Rate
limits use fixed windows, which allow a burst of up to twice the limit across a window boundary.

## v0 rows (Stage 0, unchanged)
| Threat | Surface | Control | Evidence |
|---|---|---|---|
| Spoofing a request id to poison logs | API request id | Inbound `X-Request-Id` accepted only when the edge is trusted, charset and length checked | `app.test.ts` |
| Tampering with applied migrations | Migration runner | SHA-256 per migration, edit after merge rejected, database ahead of code rejected | `migrate.test.ts` |
| Information disclosure through errors | API errors | RFC 9457 responses with a closed code set; internal causes only in logs | `app.test.ts`, `errors.test.ts` |
| Identity leaking across pooled connections | RLS context | Transaction-local `set_config(..., true)`; leak test; mutation-checked | `context.test.ts` |
| Denial of service by large or slow requests | API | 256 KiB body cap, header and request timeouts, 503 on unready database | `app.test.ts`, `limits.ts` |
| Elevation through framework bugs | Next.js | Thin renderer rules, no auth in proxy, no image optimizer, no ISR, nonce CSP | ADR 0005 |
| Vulnerable software in shipped images | Container images | Distroless runtime, Trivy on every push, non-root, read-only, no capabilities | ADR 0009 |
| Secrets in the repository | Git | `.env` ignored, TruffleHog in CI | `.gitignore`, `ci.yml` |
