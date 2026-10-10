# 0018 — API keys, passkey step-up and organization verification
Status: accepted
Date: 2026-10-10

## Context
Organizations need machine access (API keys), the riskiest actions need stronger proof than a
session cookie (Stage 1 invariant 7), and unverified organizations must stay limited until a platform
administrator vouches for them.

## Decision
- **API keys** are `aura_<prefix>_<secret>`: a public 12-character prefix finds the row, a 256-bit random
  secret proves possession. Only SHA-256 of the secret is stored (a plain hash is right for a
  random 256-bit value; a slow hash would only slow every request). The whole key is returned once, at
  creation. The comparison is constant-time and runs against a dummy hash when the prefix is unknown, so
  timing does not reveal which prefixes exist. Keys expire (default 90 days, at most 365), can be
  revoked (one way, enforced by a trigger), are limited to 20 live keys per organization (locked
  trigger) and carry scopes; Stage 1 has one, `org:read`. Owners and admins manage keys, and the
  application role can never read the hash.
- **A request with `Authorization: Bearer aura_…` is judged by the key alone**; a cookie beside it is
  ignored, so a bad key cannot fall back to a session. The actor is `api_key`, acts for one
  organization, and the database sees `actor_kind = 'api_key'` with that organization. Policies let it
  read its own organization and nothing else yet. Key actors cannot reach any route meant for people.
- **CSRF exception (promised in ADR 0013):** requests authenticated by an API key skip the cross-site
  check, because the credential travels in a header the browser never adds by itself, so there is no
  ambient credential to ride on. Everything else keeps the check.
- **Step-up.** A privileged action needs a passkey check within the last 15 minutes: a passkey sign-in
  counts, so does registering a passkey, so does a step-up (`POST /auth/passkey/step-up/options|verify`,
  a third challenge purpose bound to the signed-in person, verifying only that person's passkeys). A
  stale session gets `403 step_up_required` (a new error code); a person with no passkey is told to
  add one. Privileged actions today: changing anyone's role, removing an owner or admin, creating or
  revoking API keys, verifying an organization. Leaving an organization and removing plain members
  are not privileged.
- **Privileged sessions.** A session started by any sign-in method is "privileged" (30-minute idle
  limit) when the person is a platform administrator or an owner or admin of any organization other
  than their personal space. When someone is given owner or admin, their existing sessions are ended
  (`privilege_change`) so the next sign-in carries the stricter limit; the person making the change
  keeps theirs. Not done: a person who creates their own team keeps their current session's 7-day idle
  limit until the next sign-in; the step-up requirement is what protects their privileged actions.
  Recomputing the limit on every request was done in slice 8 (ADR 0021).
- **Organization verification.** `verify_org()` is a SECURITY DEFINER function that checks the caller is
  a platform administrator before changing anything; the route `POST /admin/orgs/{id}/verify` also
  checks, requires step-up, and answers 404 to everyone who is not an administrator so the route does
  not advertise itself. Platform administrators are created by an operator (`update users set
  platform_role = 'admin'`); there is no sign-up path to it.

## Alternatives considered
Signed (JWT) keys: cannot be revoked instantly without a lookup anyway. Argon2 for key secrets: pointless
for 256 random bits. TOTP for step-up: not built (Stage 1 decision 3). Requiring step-up for every
organization write: friction without matching risk.

## Consequences
Keys are bearer credentials: whoever holds one acts as the organization within its scope, which is why
creating them needs step-up and why they expire. Operators must know the platform-admin procedure.

## Verification
`api-keys.test.ts` (11 database cases, five migration mutations caught), `api-key.test.ts` (format and
parsing), `http-keys.test.ts` (19 end-to-end cases), the authorization matrix, and 15 injected faults
(14 caught directly; one only affects behaviour the database function also guards, so it is
covered at the database level).

## Revisit trigger
Keys that write (then scopes, rate limits per key and audit of use become urgent), many platform
administrators (then a separate admin application), or a need for per-request privilege recomputation.
