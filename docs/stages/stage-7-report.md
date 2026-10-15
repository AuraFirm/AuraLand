# Stage 7 report: Passport (verifiable credentials)

Status: built, awaiting your review. Plan: [stage-7-plan.md](stage-7-plan.md). Decisions: `docs/adr/0033-stage-7-decisions.md`
(with the amendments that record every deviation). Runbook: [../runbooks/passport.md](../runbooks/passport.md).
**Everything was signed by an in-memory development signer. There is no production signer (no KMS), so nothing here may be called
a production credential, and Passport is off in staging and production.**

## What exists
| Slice | What | PR |
|---|---|---|
| 0 | Plan accepted, ADR 0033, Passport vocabulary (strict claim schemas, points bands), threat model v9 | #113 |
| 1 | `signing_keys` (public keys, lifecycle, one active per environment), the `Signer` port, a development signer that refuses to exist outside local and test | #114 |
| 2 | VC-JWT issuance (Open Badges 3.0 profile, ES256), verifier, DID document and key set, `credentials` | #115 |
| 3 | Signed revocation list (bitstring), revocation, static publishing through a small put/get on the storage port | #116 |
| 4 | Public endpoints that answer without the database, `/verify/<id>` | #117 |
| 5 | Credential issuance simulation (crashes, races, rotation, revocation) | #118 |
| 6 | `/passport`: visibility (private by default), share links | #119 |
| 7 | Credentials from rated contests and released exams; the worker tick | #120 |
| 8 | **Not built** (identity port has no consumer) | n/a |
| 9 | Employer v0 with a log the holder sees | #121 |
| 10 | Re-signing after a key revocation, rotation drill, runbook, ASVS rows, this report | this PR |

## Verified (with evidence)
- **A credential verifies with software that shares none of our code**: `did-jwt` (its own JWT, key and DID handling) accepts our
  JWT through the DID document alone and refuses a tampered copy. Our verifier also refuses: tampering, another key under the same
  id, a revoked or unknown key, `alg: none`, HS256 confusion, oversize and garbage; it tells expired from valid at the exact second.
- **Verification works with the database closed**: a test closes the connection and asks the real HTTP app for the verification,
  the DID document, the key set and the revocation list. A missing or unreadable revocation list gives `status_known: false`, never
  a quiet "not revoked"; a private credential and one that does not exist return the identical answer.
- **Issuance is idempotent and honest**: 500/500 simulation seeds (crashes at three points, racing workers, key rotation, key and
  credential revocation): one credential per (person, event); no shared place in a revocation list; a bit is set exactly when
  revoked; every credential verifies unless its key was revoked. Two mutations (a shifted signed place; a list that skips bit 0)
  both fail it within a few seeds. The uniqueness invariant rests on a store double that copies the database's constraint, which
  `issuing.database.test.ts` exercises for real.
- **The rotation and compromise drill** (`rotation.database.test.ts`): rotating keeps old credentials verifying; revoking the old key
  makes them invalid; re-signing brings them back with the same id, claims and place; a credential revoked on its own is left alone;
  nothing else may rewrite signed text.
- **Privacy rules are tests**: credentials start private; a share link's secret is stored only as a hash, opens only its own
  credential, ends at expiry, revocation or going private; employers see public credentials that name no one, a report is logged in
  the same statement and shown to the holder as organization, purpose and time (never the person); no exam credential for a
  person with a confirmed, un-overturned integrity flag.
- Gates at the end: `pnpm check` clean; `pnpm test` 1,782 tests in 164 files; `pnpm test:sim` nine scenarios 500/500 (new:
  `credentials`); `pnpm test:e2e` 51 browser tests (axe on the verify page's outcomes, `/passport`, `/employer`); migrations 0053
  to 0060.

## Mistakes and fixes worth knowing
- **A holder with no role in the issuing organization could revoke a credential**: a null role made the refusal condition null
  instead of true. A test caught it before it merged; fixed with `coalesce`, and I checked the other `app_org_role` conditions.
- CodeQL found an incomplete encoding of a `did:web` host (`replace` of the first colon only); fixed with `replaceAll`.
- My first public routes sat under the authenticated `/v1` pipeline (database, session): moved outside it so verification does not
  depend on the database.
- Several tests had to learn the repository's limits (function length) and one S3 contract timeout and several registry rate limits
  failed CI runs that passed on re-run (the S3 one is not mine and still flaky at 5 s).

## Not verified, not built
- **No production signer** (F62): ASVS V13.3.1 and V13.3.3 are **not met**. **No human review of the signing code** (F63).
- No identity verification (F64): slice 8 was deliberately not built.
- The "works with the database down" claim is tested at the API against static files; no real edge or CDN (F65).
- No QR codes, share cards or Idempotency-Key on link creation (F66). Employer v0 is minimal and **needs legal review before any
  real employer** (F67). Replay highlights are not in employer reports.
- Ed25519 versus ES256 on KMS is unanswered; only ES256 is implemented.

## Decisions I made that you may overrule
1. Public endpoints live under `/api/public`, outside the `/v1` pipeline; the verify page is client-rendered, not SSR.
2. Exam credentials issue for every band including 0-24%; validity 5 years.
3. A credential names no person (an opaque subject); holders choose visibility; employers see public ones only.
4. Re-signing after a revoked key keeps ids, claims and places in the revocation list.
5. No KMS adapter was written without a KMS to run it against.

## Next
You: `docs/owner-tasks.md` section 3.9. Engineering, when unblocked: F62 to F67, then Stage 8 per `docs/kit/12`.
