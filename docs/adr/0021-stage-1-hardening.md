# 0021 — Stage 1 hardening decisions
Status: accepted
Date: 2026-10-10

## Context
The ASVS 5.0 mapping for authentication, session management and authorization (V6, V7, V8), done
against the official requirement list, found gaps worth closing before the stage sign-off, and
Stage 1 still owed an account-takeover drill and a no-secrets-in-logs test.

## Decision
- **Out-of-band lifetimes follow the standard (V6.5.5).** The sign-in link now lives 10 minutes (was
  15) and the typed code 5 (was 10). Code stays shorter than the link because it is the guessable one.
- **Power tightens a session at once (V8.3.2).** The 30-minute idle limit is no longer fixed when a
  session starts. On every request a session that began as ordinary is checked against the person's
  current standing (platform administrator, or owner or admin of a non-personal organization), and if
  they hold power its idle deadline is pulled in to last activity plus 30 minutes. This closes the
  limit recorded in ADR 0018 (someone who creates their own team no longer keeps a 7-day session). Cost:
  one indexed query per request for sessions that were not already privileged.
- **Changing how someone proves who they are needs a fresh passkey check (V7.5.1).** Removing a
  passkey, and disconnecting a sign-in provider for someone who holds a passkey, join the privileged
  actions of ADR 0018. Someone with no passkey has nothing stronger to show and is not blocked.
- **Platform administrators can end a person's sessions (V7.4.5):**
  `POST /admin/users/{id}/revoke-sessions`, with the same guards as organization verification (platform
  role, fresh passkey check, 404 for everyone else, audit entry).
- **Sign out on every page (V7.4.4):** a site header with the link, driven by a status route
  (`GET /me/status`) that always answers 200, so asking never looks like an error in the console.
- **Proof, not promises.** `http-red-team.test.ts` plays credential stuffing, a botnet against one
  victim, a leaked binding cookie, flooding of challenge rows and key guessing, and asserts the numbers
  in `docs/security/authentication.md`. `http-log-hygiene.test.ts` runs every flow with debug logging
  and no redaction and asserts that no email, link, code, cookie, key or provider value appears in any
  log line. The redaction list also gained code, otp, key, binding and email.
- **Documented, not hidden.** Four requirements are recorded as not met and five as partial in
  `docs/security/asvs-matrix.md` with follow-up numbers in `docs/cutlist.md`. The notable acceptance:
  email and OAuth sign-ins are single-factor by product decision (V6.3.3, V6.3.6), which the passkey
  step-up for powerful actions compensates.

## Alternatives considered
Raising the standard-conflicting lifetimes in the standard's favour only on paper; hashing codes with
a password hash (F5); recomputing power by storing a flag and revoking on every role change (stale if
a change is made by SQL, and more write paths).

## Consequences
Tests that keep a team owner's session idle for more than 30 minutes now sign in again; operators who
promote someone by SQL see the effect on the person's next request.

## Verification
Rule and service tests for the dynamic limit, HTTP tests through the real app, six injected faults
caught, the drill and hygiene tests, and 19 browser tests including the new header.

## Revisit trigger
The ASVS requirement text is read more strictly than here (F5), or notifications and adaptive controls
(F3, F6) are scheduled.
