# Stage 7 plan (draft): Passport, verifiable credentials

Status: **draft for your review. No Stage 7 code starts until you approve it** ("defaults" accepts every default below).
Kit: `docs/kit/12` Stage 7, `03` (credentials), `05` (signing_keys, credentials), `06` (Passport API, verification
availability), `08` (key custody, ASVS L3 for signing), `09` (verify page, employer), `10` (credential DST), `11` (static artifacts),
`15` (open questions 8 and the credentials row).

## 1. Where this starts
Stage 6 is built. Reusable: the worker tick and job queue, definer functions with an injected clock, the audit log, the privacy
documents, the egress client, SSR pages in the Next renderer, the simulation harness. Events that can earn a credential exist:
finalized rated contests (Stage 5) and released exam grades (Stage 6). **No signing, keys, DID, status list or verify page exists.**

## 2. Honest limits of this stage
- **KMS.** The kit keeps signing keys in KMS and the API never holds a private key. There is no cloud account (F1). I build the
  `Signer` port, a **development signer** (a key in process memory, **refused outside development and test**) and an AWS KMS adapter
  written to the documented API but **not run** against KMS. Anything signed here is a development credential, marked as such, and
  no one may be told it is production-grade (F62).
- **Ed25519 or ES256.** Whether KMS signs Ed25519 is unverified (kit 15 item 8). **Default: ES256 (P-256)**, which KMS supports;
  the code reads the algorithm from the key row, so EdDSA can follow with an ADR.
- **Independent verification** ("verifies with an independent open-source VC verifier") is run in tests with a library other than
  the one that signs; I report exactly which one and what it checked. Interop with a *particular* buyer's verifier is not claimed.
- **Identity.** `IdentityVerifier` for assurance level 1 and above needs a vendor account. I build the port and a fake; credentials
  carry the assurance level the event actually had (exams here are level 1 at most; contests level 0), never more.
- **Static artifacts "with the DB down"** are produced and tested as files; serving them from S3 and a CDN needs the deployment
  (F1, F33), so the DB-down claim is verified against the files and the SSR page's fallback, not against a real edge.
- **Employer module v0** is invite-only search and a report view. It raises the heaviest privacy questions of the product
  (candidate PII at scale); the design (consent, purpose, logging, MFA) is built, but it should not be switched on for real
  employers before legal review and the key review below.
- A human must read the signing and key-management diff (kit 08 L3): the report lists exactly what to read.

## 3. Decisions I need from you (my default in bold)
1. **Slice order.** **Keys and signer first, then issuance, status list and DID, then the verify page and JSON, then candidate controls
   (visibility, share link), then issuance jobs from contests and exams, then employer v0, then rotation and runbook.**
2. **Format.** **VC-JWT, Open Badges 3.0 profile, ES256; `did:web` for the issuer; JWKS beside it.** Data Integrity and wallets out of scope (kit).
3. **Library.** **`jose` for JWS (new dependency, needs an ADR; it is the standard, audited choice, no custom crypto).** A second
   library as a devDependency only, for independent verification in tests.
4. **Issuer.** **One platform issuer (`did:web:<host>`) issues on behalf of the event host**; the host organization is named in the
   credential. Per-organization issuers wait for a customer asking.
5. **What earns a credential.** **Contest: a finalized rated contest, one credential per (person, contest), assurance 0, claim = rank
   and solved count. Exam: a released exam, one per (person, exam), assurance = the exam's level (1), claim = points band only
   (no per-problem detail), AI mode recorded, and never if an integrity flag against the person is `confirmed` and not overturned.**
   Forge qualification credentials wait for that product.
6. **Subject consent and visibility.** **Issuing is automatic but private: the person sees it in `/passport` and chooses `private`
   (default), `link` (selective-disclosure link) or `public`. The public verify page shows only what the person chose.** Revoking by
   the person hides it; revoking by the issuer flips the status bit and says why in general terms.
7. **Status list.** **A compressed bit string (Bitstring Status List style), 131,072 entries per list, published as a static file and
   rebuilt by the worker on every change; the credential holds its list URL and index.** A bit is set exactly when revoked.
8. **Expiry.** **Contest credentials do not expire; exam credentials expire after 5 years** (placeholder you can change).
9. **Verify page.** **`/verify/<id>` is SSR, cacheable, shows valid / revoked / expired / invalid with the reason, what it proves and
   what it does not (assurance level, AI mode), and works from the signed JWT plus the cached status file, not the database.**
10. **Employer v0.** **Invite-only employer accounts with MFA; search over `public`-visibility holders by event and band; each report
    view is logged and shown to the candidate; no employer sees `private` or `link` credentials unless given the link.** Replay
    highlights are **not** included in v0 (they expose exam evidence; legal review first).
11. **Key lifecycle.** **Rotate yearly or on suspicion; an `active` key signs, `retired` keys still verify, a `revoked` key's
    credentials are re-issued under a new key and the incident note is published.** The drill runs against the development signer
    and the real rotation code; a KMS drill needs KMS.
12. **Idempotency.** **`credential.issue` is a job with a dedupe key per (subject, event); re-running changes nothing; `Idempotency-Key`
    on POST routes that create credentials or share links.**

## 4. Work breakdown (one pull request each, tests first; report after each part)
**7A: keys, issuance, verification**
| # | Slice | Verify |
|---|---|---|
| 0 | ADR 0033 (decisions above, `jose` and the second library), contracts (credential claims, states, limits), threat-model section, privacy review for Passport | review; contract tests |
| 1 | `signing_keys`, `Signer` port, development signer (refused in production config), KMS adapter (unrun), key states and rotation functions | db tests; signer contract test run against the dev signer; refusal test |
| 2 | VC-JWT issuance (OB 3.0 profile), `credentials` table, status index allocation, `did:web` document and JWKS as static files | schema tests; **independent verifier accepts the JWT**; tamper and wrong-key cases rejected |
| 3 | Status list build and publish, revocation, expiry | revoke flips exactly one bit; list round-trips; golden file |
| 4 | Public verify page (SSR) and JSON endpoints; offline verification from files | browser test; valid, revoked, expired, tampered, unknown cases rendered; works with the database stopped |
| 5 | **DST: credential issuance** (crash, repeat, rotate, revoke interleavings) | **one credential per (subject, event); bit set iff revoked; every issued JWT verifies with the key set**; many seeds, mutation-checked |

**7B: from events to people**
| # | Slice | Verify |
|---|---|---|
| 6 | `/passport` for the person, visibility, selective-disclosure share link and QR | HTTP and browser tests; private by default; link scopes what is shown |
| 7 | Issuance jobs from finalized contests and released exams (with the integrity rule) | job tests; no credential for a confirmed flag; re-run idempotent |
| 8 | `IdentityVerifier` port and fake; credentials carry the real assurance level | contract tests; assurance never exceeds the event's |

**7C: employers, rotation, docs**
| # | Slice | Verify |
|---|---|---|
| 9 | Employer v0: invite-only accounts, MFA, public-only search, report view, access log shown to the candidate | HTTP tests, authz matrix, RLS; privacy review |
| 10 | Rotation drill and incident runbook; ASVS rows for signing and key management; threat model; report | drill output; the list of code a human must read |
| 11 | (only if you want it) share cards | browser test |

## 5. Security notes
Signing keys never leave the signer; the API holds a key id and asks for signatures; the development signer exists only where
configuration says development or test, and the process refuses to start otherwise. Credentials contain no more than the person
could be shown: no emails, no per-test results, no integrity evidence. The status list reveals only that an index is revoked. The
public verify page and JSON reveal nothing about people who chose `private`. Employer access is consented, purposeful, logged and
visible to the candidate. Every issuance, revocation, visibility change and key change is audited. Output encoding for the verify
page follows the existing `SafeHtml` rules; credential text from hosts is data, rendered as text.

## 6. What this still will not do
Production-grade signing (no KMS run), identity proof beyond a fake, an employer product for real employers without legal review,
Data Integrity proofs, wallets, marketplace payments, or any claim that a development credential is a real one.

## 7. Things only you can provide
A cloud account and KMS (F1), with a decision on Ed25519 versus ES256 once KMS is tested; a domain for the issuer DID (D3); an
identity-verification vendor (for level 1 and above); legal review of the employer module and the candidate-consent text; a human
reviewer for the signing and key-management code; a pilot employer if you want one.
