# ASVS 5.0 mapping: self-contained tokens, cryptography, secrets (Stage 7, Passport)

Standard: OWASP ASVS 5.0.0, requirement text read from the official CSV (`v5.0.0` tag) on 2026-10-15. Chapters: V9.1 (self-contained
tokens: a credential is a signed JWT), V11 (cryptography), V13.3 (secret management), plus data minimization. Signing and key
management are an L3 area (kit 08): **the human review of the signing code has not happened** (list in the Stage 7 report).

| ID | L | Requirement (shortened) | Status | Evidence or reason |
|---|---|---|---|---|
| v5.0.0-V9.1.1 | 1 | Self-contained tokens validated by signature or MAC before their contents are accepted | Met | `verifySignature` runs before any payload is read; tampered payloads, other keys and unsigned tokens are refused (`vc.test.ts`, `status-list.test.ts`, `public-verify.database.test.ts`); an independent library (`did-jwt`) accepts the same tokens and refuses the same damage |
| v5.0.0-V9.1.2 | 1 | Only allowlisted algorithms create and verify tokens | Met | ES256 only, in the header check and in `compactVerify(..., { algorithms: ["ES256"] })`; `alg: none` and HS256 confusion are tested and refused |
| v5.0.0-V9.1.3 | 1 | Key material for validation comes from trusted pre-configured sources, not from the token | Met | The key is chosen by `kid` from our published key set (database or the static key file), never from a header-supplied key or URL; a `kid` not in the set, or revoked, is invalid |
| v5.0.0-V11.1.1 | 2 | Documented key-management policy and lifecycle, keys not overshared | Partial | Lifecycle (active, retired, revoked; one active per environment; rotation and compromise steps) is in the runbook and ADR 0033 and exercised by `rotation.database.test.ts`. It does not yet follow a named standard line by line (NIST SP 800-57) and has had no external review |
| v5.0.0-V11.1.2 | 2 | Maintained cryptographic inventory | Partial | Inventory in the runbook: ES256 credential signatures, SHA-256 for share-link secrets and status digests, gzip for the status list, session and login secrets from earlier stages. Not yet maintained by tooling |
| v5.0.0-V11.2.1 | 2 | Industry-validated cryptographic implementations | Met | `node:crypto` (ECDSA P-256, SHA-256) and `jose`; no custom cryptography. A KMS would be the production implementation (F62) |
| v5.0.0-V11.2.2 | 2 | Crypto agility | Partial | The algorithm is read from the key row and the check is an allowlist, so EdDSA can be added by an ADR; only ES256 is implemented |
| v5.0.0-V11.2.3 | 2 | At least 128 bits of security | Met | P-256 gives about 128 bits; SHA-256; 256-bit share secrets |
| v5.0.0-V11.4.1 | 1 | Only approved hash functions | Met | SHA-256 throughout; no MD5 or SHA-1 |
| v5.0.0-V11.5.1 | 2 | Non-guessable values from a CSPRNG with at least 128 bits | Met | Share-link secrets are 256 random bits from `systemRng` (the OS CSPRNG); credential ids are UUIDv7 (time-ordered, 74 random bits) and are identifiers, not secrets: a private credential is not protected by its id but by its file not being published |
| v5.0.0-V11.6.1 | 2 | Approved algorithms for key generation and signing | Partial | ECDSA P-256 with the OS generator in the development signer; production key generation would be inside KMS (not built, F62) |
| v5.0.0-V13.3.1 | 2 | A secrets-management solution creates, stores and controls access to key material | **Not met** | No KMS exists to run against (F1, F62). The development signer keeps its key in process memory and refuses to start outside local and test |
| v5.0.0-V13.3.3 | 3 | Cryptographic operations inside an isolated security module | **Not met** | Same: this is exactly what the KMS adapter, once it can be tested, provides. Until then there is no production signer and Passport is off in production (the worker says so) |
| v5.0.0-V14.2.1 | 1 | Sensitive data not in the URL | Partial | A share link carries its secret in the address (`?s=`) by design: it is a bearer link the holder chose to make, 1 to 30 days, revocable, answered with `Cache-Control: private`. Credentials themselves and everything else travel in bodies |
| v5.0.0-V14.2.6 | 3 | Return only the minimum required sensitive data | Met | Claim schemas are strict (no email, no per-test results, no integrity evidence); exam points are shown as a quarter; employers see public credentials that name no one; holders see which organization looked, never which person |
| v5.0.0-V16.2.5 | 2 | Logging by data protection level | Met | Audit rows carry ids, kinds and counts; share secrets and tokens are never logged or stored (only a hash) |
| v5.0.0-V16.3.2 | 2 | Failed authorization attempts logged | Partial | Refusals are in the request log; issuance, revocation, visibility changes, links, employer approval and every employer report are audit events; refusals are not audit events |
| v5.0.0-V8.2.1 | 1 | Function-level access restricted to explicit permissions | Met | Every Passport route has an authz-matrix row; revocation and approval are database-checked (administrator, issuer admin); employers need approval plus a fresh passkey check |
| v5.0.0-V8.2.2 | 1 | Data-specific access (IDOR, BOLA) | Met | A holder's functions check `subject_user_id = app_user()`; another person's credential id is a 404 (matrix `owned` rows); a flaw found while building (a holder could revoke when their role was null) was fixed and is tested |
| v5.0.0-V8.3.1 | 1 | Authorization at a trusted service layer | Met | PostgreSQL functions and policies decide; routes translate |
| v5.0.0-V15.2.1 | 1 | Components within update timeframes | Partial | `jose` and `did-jwt` are pinned and under the existing `pnpm audit`/Dependabot/Trivy regime; `did-jwt` is test-only |

Not covered here: transport security and the edge (F33) and the human review of signing and key management (kit 08 L3 gate).
