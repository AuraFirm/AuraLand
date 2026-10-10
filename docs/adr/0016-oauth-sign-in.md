# 0016 — OAuth sign-in (GitHub, Google) without a library
Status: accepted
Date: 2026-10-10

## Context
People can sign in with GitHub or Google (ADR 0011). The Stage 1 plan named Arctic for the OAuth
flow. Two things in our own rules pull against using it: all outbound HTTP must go through the
egress client (fixed origin, no redirects, timeout, size cap), and the tests must run against a
fake provider. Arctic calls the global `fetch` itself and has fixed provider endpoints, so we would
bypass the first rule and could not do the second without patching it.

## Decision
- **No OAuth library.** The authorization-code flow with PKCE is small: build a URL, post a form,
  read a profile. We write it (`oauth-providers.ts`, about 200 lines) on the egress client, which
  gained `postForm` and `getJson`. This removes the planned `arctic` dependency and its three
  `@oslojs` packages. PKCE challenge and state come from our injected RNG and `node:crypto` SHA-256;
  no cryptography is invented.
- **Flow state.** `POST /auth/oauth/{provider}/start` stores an `oauth_flows` row holding HMAC hashes
  of the random `state` (travels in the redirect) and the PKCE verifier (kept in an HttpOnly
  cookie), valid 10 minutes, usable once, spent in a single statement. The callback needs all of: the
  state, the cookie, the same provider, an unexpired unused row. A callback forwarded to another
  browser has no cookie and fails (login CSRF).
- **Fixed redirect URI.** Computed from `AURA_PUBLIC_ORIGIN`, never read from a request.
- **Profiles.** GitHub: `/user` (stable numeric id) and `/user/emails` (primary and verified only).
  Google: `userinfo` with the access token we just received over TLS (no separate ID-token check
  needed); `email_verified` must be true. The provider's id identifies the person, never the email.
- **Account linking is never silent.** A known identity signs its owner in. A new identity may create
  an account only with a provider-verified email that no account uses. If an account already uses
  it, nothing is linked: the person must sign in another way and connect the provider from
  settings (`purpose: "link"`, which needs a signed-in session that must still be the one signed in
  when the flow ends). This closes pre-account takeover.
- **Outcomes.** The callback is a browser navigation, so it answers with a redirect to
  `/auth/done?status=signed_in|linked|failed[&reason=<fixed word>]`; no personal data in the address.
  Reasons: denied, invalid, email_unverified, account_exists, identity_taken, suspended, unavailable.
- **Limits.** 10 starts plus callbacks per address per minute. Refusals are audited without personal data.
- **Configuration.** A provider is on only when both its client id and secret are set. Nothing is on
  by default, so a fresh checkout cannot start a flow against a real provider.

## Alternatives considered
Arctic (above). Better Auth (ADR 0011). Linking by matching verified email: convenient, but a
provider that verifies mailboxes more weakly than we do becomes a way into our accounts.

## Consequences
We own about 200 lines of protocol code and must follow provider changes (GitHub or Google changing an
endpoint or response). The fake provider enforces PKCE and rejects reused codes, so the main paths
are covered, but only a real sign-in proves the registration with each provider.

## Verification
`oauth-providers.test.ts` (both adapters against the fake provider), `http-oauth.test.ts` (22 end-to-end
cases: new accounts, returning sign-in after an email change, pre-account takeover, unverified email,
state/cookie/provider tampering, reuse, expiry, denial, outage, PKCE mismatch, linking, unlinking,
limits), `oauth.test.ts` in `packages/db`, and 14 injected faults (13 caught directly; the other one
was only covered by a redundant second check, so a test was added that distinguishes it).

## Revisit trigger
Adding a third provider (then extract the shared parts), a provider requiring OIDC ID-token
validation, or the egress client gaining an allowlist form for provider hosts.
