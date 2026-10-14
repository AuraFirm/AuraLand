# 0033 — Stage 7 decisions (Passport, verifiable credentials)
Status: accepted
Date: 2026-10-15

## Context
The owner accepted the defaults of `docs/stages/stage-7-plan.md`. A credential is a claim the product signs about a person,
shown to people who were not there. Three things shape every choice: the signing key never reaches the application; a
credential says no more than the event proved; and a verifier must be able to check it without trusting our database being up.

## Decisions
1. **Order.** Keys and signer, then issuance, status list and DID, then the verify page, then the person's controls, then
   issuance from contests and exams, then employer v0, then rotation and the runbook (slices 0 to 10; share cards optional).
2. **Format.** VC-JWT in the Open Badges 3.0 profile, ES256 (P-256, which KMS signs). `did:web` issuer, JWKS beside it. The
   algorithm is read from the key row, so EdDSA can follow with an ADR once KMS support is verified (kit 15 item 8). Data
   Integrity proofs and wallets are out of scope.
3. **Libraries.** `jose` for JWS signing input and verification primitives (apps/api, runtime). `did-jwt` as a test-only
   dependency (apps/api devDependency) that verifies our output independently: it has its own JWT, key and DID handling, so it
   would not share our mistakes. No custom cryptography. Exact versions are pinned in `docs/adr/deps.json` when each is installed.
4. **Signer port.** `Signer { keyId, alg, sign(bytes) }`; the application holds a key id and asks for signatures. Adapters: a
   **development signer** (key in process memory; the process refuses to construct it unless the environment is development
   or test) (amended in slice 1: the **AWS KMS adapter is not written** until a KMS account exists to run it against; unrun code is a
claim without observation, so it waits with F1 and F62).
   Credentials signed by the development signer carry `"environment": "development"` in the issuer metadata and are never
   called production credentials.
5. **Issuer.** One platform issuer, `did:web:<host>`, issues for the event host; the host organization is named in the claim.
6. **What earns a credential.** Contest: a finalized rated contest, one per (person, contest), assurance 0, claims rank,
   participants and solved. Exam: a released exam, one per (person, exam), assurance = the exam's level, claims a points band
   (quarters) and the AI mode, never per-problem detail. **No exam credential while an integrity flag against the person is
   `confirmed` and not overturned.** A credential names no email, no per-test result, no integrity evidence.
7. **Visibility.** Issued private. The person chooses `private`, `link` (a share link with an expiry of 7 days by default,
   30 at most, revocable) or `public`. The public verify page shows only what the person chose.
8. **Status list.** A compressed bit string of 131,072 entries per list, published as a static file and rebuilt by the worker
   on every change; the credential holds its list URL and index. A bit is set exactly when the credential is revoked. Revoked
   keys' credentials are re-issued under a new key and an incident note is published.
9. **Expiry.** Exam credentials expire after 5 years (a placeholder); contest credentials do not. Expiry is read from the
   clock, never stored as a state.
10. **Verify page and JSON.** `/verify/<id>` is server-rendered and cacheable; it verifies the stored JWT against the published
    key set and status file and says valid, expired, revoked, invalid or unknown, with what the credential proves and what it
    does not. Verifiers can do the same offline from the JWT, `did.json`/JWKS and the status list.
11. **Employer v0.** Invite-only accounts with MFA, search over `public` credentials only, each report view logged and shown to
    the candidate. No replay highlights. Not for real employers before legal review.
12. **Idempotency.** Issuance is a job with a dedupe key per (subject, event); `Idempotency-Key` on POSTs that create
    credentials or share links. A simulation covers crashes, repeats, rotation and revocation interleavings.

## Consequences
New tables (slices 1 to 2, 6) carry RLS and rows in the RLS matrix and ADR 0003. Static artifacts (`did.json`, JWKS, status
lists) are written by the worker to object storage under a public prefix; serving them from an edge is deployment work (F1, F33).
Every claim about "works with the database down" is tested against those files, not a deployed edge.
