# 0014 — Email sign-in: challenges, mail transport and rate limits
Status: accepted
Date: 2026-10-10

## Context
Email sign-in (a link and an 8-digit code in one message) is the first way into the product
(ADR 0011). It handles secrets that an attacker wants (the link, the code), a flow that can be
used to enumerate accounts or to flood a person's inbox, and an outbound call to a mail service.

## Decision
- **One challenge per request.** `login_challenges` holds an HMAC-SHA-256 of the link token, of the
  code and of a random browser-binding value. The key is `AURA_LOGIN_TOKEN_SECRET` (at least 32
  bytes) and each input is prefixed with its purpose (`link:`, `code:`, `binding:`), so a value for
  one purpose can never be replayed as another. A database leak alone does not yield a usable
  link or code; the 8-digit code is only safe because the key is missing from the leak.
- **Binding.** The browser that asked for the email receives the binding value in a cookie. Both
  the link and the code only work together with that cookie, so a link forwarded to, or
  opened by, another browser fails.
- **Lifetimes and limits.** Link 15 minutes, code 10 minutes, at most 5 wrong code guesses per
  challenge, one successful use. Every check is a single SQL statement (`update … where … returning`),
  so concurrent guesses cannot both pass and a counted guess cannot be skipped.
- **Rate limits.** Fixed-window counters in `rate_limit_counters`, keyed by an HMAC of the rule name
  and the identifier (email or network address), so the table holds no readable addresses. The
  count is a single upsert, so simultaneous requests get distinct counts. Old windows are not
  deleted yet; a cleanup job arrives with the worker (Stage 3).
- **Mail over HTTP.** The API posts JSON to a mail service through the fixed-origin egress client
  (no redirects, a timeout, a response size cap, a path allowlist). Locally that is Mailpit's send
  API. Production uses the `disabled` driver, which refuses to send, until a provider adapter is
  written with its own ADR. The `mailpit` driver is rejected by configuration outside local and test.
  No SMTP library is added: no new dependency, no extra protocol.
- **Database roles.** The sign-in tables are reachable only by `aura_auth`; `aura_app` has no
  privileges on them (ADR 0012). Column grants allow only the updates the flow needs.

## Alternatives considered
Storing the plain code with a short expiry: a leak would be directly usable. A signed stateless
token: cannot be made single-use or attempt-limited without storage anyway. nodemailer: a large
dependency for one request type. Redis counters: a new service for a table's worth of state.

## Consequences
Anyone with the secret and the database can compute valid codes for stored challenges, so the
secret lives only in the environment and is rotated by invalidating open challenges (they live
minutes). A fixed window allows a short burst across a window boundary (up to twice the limit); the
limits are chosen with that in mind.

## Verification
`login.test.ts`, `challenge-store.equivalence.test.ts` (memory and PostgreSQL stores give identical
answers, including a guess flood), the `login` simulation (300 seeds, five injected faults each
caught), `login.test.ts` in `packages/db`, `egress.test.ts`, `mail.test.ts` (with a real Mailpit),
and `rate-limit.test.ts` (including twelve simultaneous requests against PostgreSQL).

## Revisit trigger
Choosing a production mail provider; abuse that fixed windows do not contain (then sliding windows
or an edge limiter); adding more sign-in methods that share the challenge table.
