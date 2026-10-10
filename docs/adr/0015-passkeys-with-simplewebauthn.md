# 0015 — Passkeys with SimpleWebAuthn
Status: accepted
Date: 2026-10-10

## Context
Passkeys are the strongest sign-in method we offer and the second factor for privileged accounts
(Stage 1 plan, assumption 3). WebAuthn verification parses CBOR, X.509 and COSE structures and checks
signatures; writing that ourselves would be custom crypto-adjacent code. ADR 0011 already chose a
thin in-house identity module on top of SimpleWebAuthn.

## Decision
- **Dependency:** `@simplewebauthn/server` 14.0.3 (published 2026-09-25, past the 3-day rule; the
  2026 advisories are fixed from 14.0.2). It brings 23 transitive packages (`@peculiar/*`,
  `asn1js`, `@levischuck/tiny-cbor`, `tsyringe` and similar), none with install scripts. Only the
  API depends on it; the web app will use `@simplewebauthn/browser` in slice 7 when pages exist.
- **Settings:** attestation `none` (we do not vet device makers, and this avoids the attestation
  parsing paths that carried the advisories), user verification `required`, resident keys
  `preferred`, no allowed-credentials list at sign-in (so options reveal nothing about accounts),
  `requireUserPresence` and `requireUserVerification` on every check.
- **Challenges:** 32 random bytes from our injected RNG, stored in `webauthn_challenges`, spent in
  one `update … returning` statement, valid 5 minutes, bound to a purpose (and, for registration, to
  the person who asked). A spent challenge stays spent even when verification fails, because the
  ceremony routes commit their own transaction.
- **Stored data:** public key, counter, transports (only values we know), device type, backup state,
  name. The application role can list, rename and delete its own passkeys but cannot read the key or
  counter. The counter may stay at zero (many authenticators never count) but may never go down; the
  library and a database trigger both enforce that. At most 20 per person, enforced by a trigger.
- **User handle:** the opaque 16-byte account id, never the email. A sign-in whose reported user
  handle names a different account than the credential is refused.
- **Sessions:** a passkey sign-in starts a session with method `passkey` and a fresh step-up time, and
  ends the browser's previous session, like every other sign-in method.
- **Testing without a browser:** a software authenticator in the tests (`virtual-authenticator.ts`)
  signs real ES256 assertions in the browser library's JSON format, so the whole verification path
  runs against real cryptography. Playwright with Chrome's virtual authenticator joins in slice 7,
  when there are pages to drive; adding it now would test nothing the API tests do not.

## Alternatives considered
Better Auth's passkey plugin (ADR 0011: more surface than we need). Writing WebAuthn verification
ourselves: too easy to get subtly wrong. Direct attestation: needs a trust-store of device makers.

## Consequences
We trust whatever authenticator the person uses, so passkeys prove "the same key as before" and
"a person verified themselves on a device", not what kind of device it is. If the library publishes an
advisory we must update promptly; the supply-chain rules still apply to the fix.

## Verification
`passkeys.test.ts` (database rules), `http-passkeys.test.ts` (23 end-to-end cases with the software
authenticator: wrong origin, relying-party id, user verification, challenge, replay, expiry, another
person's challenge, counter regression, foreign signature, user handle, suspended account, duplicate
credential, limits), twelve injected faults all caught, and the authorization matrix.

## Revisit trigger
A need for attestation (regulated customers), conditional UI changes in browsers, or a library advisory.
