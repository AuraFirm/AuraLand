# 0013 — Session cookie and cross-site request protection
Status: accepted
Date: 2026-10-10

## Context
Sessions travel in a cookie, so every state-changing request needs protection against being
triggered from another site (docs/kit/08 sections 3 and 5). The web app and the API share one
origin (docs/kit/03), so no CORS is needed or allowed.

## Decision
- **Cookie:** `__Host-aura_session` in staging and prod; `aura_session` in local and test, where
  browsers treat plain-http localhost differently. Always `Path=/; HttpOnly; SameSite=Lax;
  Max-Age=<absolute timeout>`, plus `Secure` where the prefix is used, and never a `Domain`
  attribute. The value is the 43-character token and is validated before it is written, so a stray
  `;` or line break cannot add attributes. Real expiry is decided on the server, not by `Max-Age`.
- **Parsing:** a Cookie header over 4 KiB is ignored; a header containing the session cookie twice
  is refused (the signature of cookie tossing from a sibling origin) rather than guessed at.
- **CSRF:** safe methods (GET, HEAD, OPTIONS) pass. Every other method needs all three of: the
  custom header `X-Aura-Request: 1` (a cross-site page cannot add it without a CORS preflight, and
  we answer none); an `Origin` header equal to `AURA_PUBLIC_ORIGIN` when present; and, when `Origin`
  is absent, `Sec-Fetch-Site: same-origin`. A request with neither `Origin` nor `Sec-Fetch-Site`
  is refused. A browser-reported `Sec-Fetch-Site` other than `same-origin` is refused even with a
  matching `Origin`.
- **Scope:** the check applies to every state-changing request under `/api/v1`, not only those with a
  cookie, so a login request cannot be forged either. API-key requests (slice 6) will be exempt
  because they carry no ambient credentials; that exception is written when the keys exist.
- **Configuration:** `AURA_PUBLIC_ORIGIN` is required, must be a bare origin, and must be https in
  staging and prod.

## Alternatives considered
Double-submit CSRF tokens: more state and moving parts than the header and origin checks for a
same-origin app. `SameSite=Strict`: breaks signing in from an email link, because the link click
is a cross-site navigation. Relying on `SameSite=Lax` alone: leaves same-site siblings and older
browsers unprotected.

## Consequences
Clients other than our own pages must send the custom header. A user whose browser strips both
`Origin` and `Sec-Fetch-Site` cannot make state-changing requests; no mainstream browser does.

## Verification
`transport.test.ts` covers the cookie attributes, parsing edge cases (duplicates, wrong name, junk,
size limit at the exact byte) and a full CSRF decision table; mutation checks confirm each rule is
needed. `http-sessions.test.ts` and `authz-matrix.test.ts` check the same rules end to end through the
real HTTP app and PostgreSQL (slice 2b-ii).

## Revisit trigger
A need for cross-origin API access (then CORS and token-based CSRF are designed together), or the
move to the separate `usercontent` origin for untrusted content.
