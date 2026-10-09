# 08 — Security Specification

> Targets: **OWASP ASVS 5.0 Level 2** for the whole product, **Level 3** for: authentication/session, judge-node protocol, credential signing, tenant isolation, and the secrets/crypto surface. Also map to OWASP Top 10, OWASP API Security Top 10, and OWASP Top 10 for LLM Applications. ASVS 5.0 was released in 2025 with ~350 requirements across 17 chapters ⚠️VERIFY the current requirement IDs in the official repository and cite them as `v5.0.0-<chapter>.<section>.<req>` in `docs/security/asvs-matrix.md`.
> "Secure from all vulnerabilities" is not a claim anyone can honestly make. The goal here is **systematic elimination of vulnerability classes by construction**, layered detection, and fast response.

## 1. Threat actors
| Actor | Goal | Primary controls |
|---|---|---|
| Cheating candidate | Pass an exam/contest dishonestly | Assurance levels, identity, telemetry, oral defence, similarity, rate limits, human review |
| Hostile submitter / AI agent | Escape sandbox, read hidden tests, reward-hack | file 07 |
| Malicious tenant | Read another org's tasks/data | RLS, authz, per-tenant encryption, tests |
| Account attacker | Credential stuffing, phishing, session theft | Passkeys, rate limits, Turnstile, device sessions, anomaly alerts |
| Malicious insider/contractor | Leak task IP | Least privilege, sandboxed authoring workspace, watermarking, audit, NDA |
| Supply-chain attacker | Poisoned dependency/CI | Pinning, release-age delay, no install scripts, provenance, SBOM |
| Network attacker / DDoS | Disrupt contests | Cloudflare, load shedding, SSE caps, autoscale |
| LLM prompt-injector | Manipulate graders/tutors | LLM never sole authority, no tools, output schemas, isolation |

## 2. Architectural security rules
1. **Trust boundaries are explicit** (file 05 §1). Data crossing a boundary is parsed with a schema and size-capped.
2. **Deny by default.** `authorize()` returns deny unless a rule matches. New routes without an explicit policy fail the startup test.
3. **Defence in depth for tenancy:** app-layer `authorize`, DB-layer RLS, per-tenant S3 prefixes with KMS encryption context (`org_id`), and cache keys always include `org_id`.
4. **Least privilege everywhere:** distinct DB roles (`aura_migrator`, `aura_app`, `aura_worker`, `aura_judge_protocol`, `aura_readonly_analytics`), IAM roles per task, S3 prefix-scoped policies, KMS key policies per purpose (signing, data, backups).
5. **No secrets in code, env files, images, or logs.** Secrets Manager (runtime), GitHub OIDC (CI), pre-commit gitleaks. Rotatable by design (two active versions).
6. **Fail closed, crash on invariant violation.**

## 3. Identity, authentication, sessions (ASVS V6/V7/V9-class)
- **Passkeys (WebAuthn) first**; email magic link/OTP fallback; password optional (if enabled: Argon2id via a vetted library with OWASP parameters, breach-password check (k-anonymity), no composition rules, length ≥ 12).
- OAuth/OIDC login (Google/GitHub/Microsoft) with `state`, PKCE, strict redirect URI allowlist, verified-email requirement before account linking (prevent pre-account takeover).
- **MFA** mandatory for: org owners/admins, Forge staff, anyone with `admin` platform role, and anyone viewing candidate PII at scale (employers). Step-up (re-auth) for sensitive actions: API key creation, payout/billing change, credential revocation, data export/delete, role changes.
- Sessions: server-side session records in Postgres; cookie `__Host-aura_session` (`Secure; HttpOnly; SameSite=Lax; Path=/`), opaque 256-bit token stored **hashed**; idle timeout 30 min for admin/employer, 7 days for learners (sliding), absolute 30 days; rotation on privilege change; "log out everywhere"; device list; **exam sessions** bound to a device fingerprint hash + IP-change alerting (informational, not auto-fail).
- Anti-automation: Turnstile on signup/login-after-failure/password reset/contest registration bursts. Account enumeration-safe responses (uniform message and timing).
- Email change/reset flows require confirmation to both old and new addresses for high-trust accounts; recovery codes are single-use, hashed.
- Enterprise: SAML/OIDC SSO + SCIM (Stage 9) behind `AuthPort`; domain verification via DNS TXT.

## 4. Authorization
- Model: `Actor {user_id?, org_roles, api_key_scopes?, node_id?}`, `Action` (string literal union per module), `Resource` (typed with `org_id`, owner, state). Pure function `authorize(actor, action, resource): Allow | Deny(reason)`. Deny reasons are logged, not returned verbatim.
- **BOLA/IDOR prevention:** every resource fetch is by `(id, org scope)` through RLS; never "get by id then check later" on user-supplied IDs. Test matrix covers each endpoint × (owner, same-org other role, other org, anonymous, API key with wrong scope).
- **BFLA:** admin routes in a separate router with platform-role + MFA + IP allowlist option; every admin action audited.
- Hidden material (tests, reference solutions, verifier code, bundle internals) accessible only to roles `setter/reviewer` of the owning org and to judge nodes via job-scoped URLs; never serialized in any contestant-facing schema (response schemas are explicit allowlists, never `select *` passthrough).

## 5. Input handling & injection classes
| Class | Control |
|---|---|
| SQL injection | Drizzle/`sql` parameterization only; tigerlint + Semgrep ban string-built SQL; DB role has no DDL; tests with sqlmap-style payload corpus on all list/filter endpoints |
| XSS | React escaping; **no `dangerouslySetInnerHTML` except through `renderMarkdownSafe()`**; markdown pipeline = parse → sanitize with strict allowlist (no raw HTML, no `javascript:` URLs, no `style`, `rel="noopener noreferrer ugc"`) → KaTeX with `trust:false`; user content that needs rich HTML (problem statements with images) is served from a **separate sandbox origin** (`usercontent.auraland.app`, no cookies) inside `sandbox` iframes if rendered as HTML at all; strict **CSP** (nonce-based, `default-src 'none'` baseline, `script-src 'nonce-…' 'strict-dynamic'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`, `connect-src 'self'`, report-to), Trusted Types enforced where supported |
| CSRF | SameSite=Lax cookies + Origin/`Sec-Fetch-Site` verification on unsafe methods + custom header requirement; no state-changing GETs |
| SSRF | Outbound fetches only via the egress client (file 06 §5): scheme/port allowlist, resolve-and-pin, block private ranges and metadata, no redirects, size/time caps; the web server and judge nodes have no route to cloud metadata (IMDSv2 hop limit 1 / blocked) |
| Path traversal / zip-slip | Never build file paths from user strings; storage keys are content hashes/UUIDs; archive extraction only in sandbox with checks (file 07 §7) |
| Deserialization / prototype pollution | JSON only, Zod `.strict()`; reject `__proto__`/`constructor` keys; no `eval`; no YAML with custom tags (use safe schema) |
| Command injection | `execFile` with arg arrays only (never shell strings); the API process spawns no subprocesses with user data |
| ReDoS | No user-supplied regex; vetted patterns only; `re2`-class engine if ever needed; fuzz regex-bearing validators |
| File upload | Presigned S3 uploads with `content-length-range`, content-type allowlist, post-upload scan + sniffing in sandbox, random keys, `Content-Disposition: attachment` on download, separate origin |
| Open redirect | Redirect targets from an allowlist or relative paths only |
| Mass assignment | Explicit allowlist schemas; never spread request bodies into DB writes |
| HTTP request smuggling / header attacks | Single trusted edge; normalize/strip hop-by-hop & `x-forwarded-*` from clients; HTTP/2 end-to-end where possible |
| Race conditions / TOCTOU | State changes via single SQL statements with predicates (`WHERE state='x'`), serializable or `SELECT … FOR UPDATE` where needed; idempotency keys; DST scenarios for contested paths |
| Business logic abuse | Rate limits, quotas, per-contest rules, anomaly detection on registrations/submissions |
| Information leakage | Uniform errors, no stack traces, no verbose SQL errors, constant-time comparisons for tokens (`timingSafeEqual`), generic auth responses |

## 6. Cryptography
- Use platform/vetted primitives only (`node:crypto`, `jose`, Go `crypto/*`, KMS). **No custom crypto.**
- Hashing: SHA-256 for content addressing/integrity; Argon2id for passwords (if enabled); HMAC-SHA-256 for webhooks/cursors; random tokens ≥ 256 bits from CSPRNG, stored hashed.
- TLS 1.2+ (prefer 1.3) at the edge and internally; HSTS preload; mTLS for judge nodes.
- Encryption at rest: RDS + S3 with KMS CMKs; per-tenant **encryption context**; envelope encryption for especially sensitive blobs (ID-verification artifacts are not stored by us beyond vendor reference; telemetry encrypted at rest at DB level).
- **Credential signing keys live in KMS** (non-exportable); the API requests signatures, never holds private keys. Key IDs (`kid`) in JWT header; JWKS / `did:web` publishes active + retired public keys. Rotation yearly or on suspicion; compromised key ⇒ revoke `kid`, re-issue affected credentials, publish incident note. ⚠️VERIFY KMS support for Ed25519; otherwise use ES256 (P-256) which KMS supports.
- Backups encrypted, cross-region copy, **restore drills quarterly**; audit-log chain heads to S3 Object Lock.

## 7. Browser/web hardening
Security headers via one function: `Content-Security-Policy` (above), `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (deny camera/mic/geolocation except exam pages that opt in), `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy` where compatible, `Cross-Origin-Resource-Policy: same-site`, cookies as above. Subresource Integrity for any third-party script (goal: zero third-party scripts on authenticated pages; analytics self-hosted/cookieless). Test with securityheaders-style CI check and ZAP baseline.

## 8. Supply chain and build security
- `pnpm`: frozen lockfile in CI; `minimumReleaseAge` (≥ 3 days) so brand-new malicious releases are not auto-adopted; `onlyBuiltDependencies` allowlist (no arbitrary install scripts); `pnpm audit signatures`/provenance checks; dependency PRs via Renovate with grouped, human-reviewed updates; **Socket-/osv-style malicious-package scan** in CI. Context: 2026 npm incidents included a coordinated malicious-version publish across dozens of widely used packages, so assume our dependencies can be hostile.
- Go: `govulncheck`, vendoring optional, `go.sum` verification, minimal modules.
- CI hardening: pinned action SHAs, least-privilege `GITHUB_TOKEN`, OIDC for cloud, protected branches, required reviews (CODEOWNERS for `judge/`, `packages/db`, `infra/`, `modules/identity`, `modules/passport`), signed commits/tags, no secrets in PR builds from forks, separate "deploy" environment with manual approval for prod.
- Artifacts: reproducible builds where feasible, container images from distroless/minimal bases, run as non-root, read-only rootfs, drop all capabilities, **SBOM (CycloneDX)** + **provenance attestation (SLSA)** + **cosign signatures** verified at deploy; Trivy scan blocking on high/critical.
- Judge agent releases are **signed**; nodes verify signatures before self-update; rollback supported.
- Secrets scanning on every push; incident-ready rotation runbook for each secret class.

## 9. Integrity and anti-cheating system security & ethics
- Collect only what is needed, **after explicit consent** (`consent_at` required before telemetry endpoint accepts data), stating purposes and retention. Biometric/webcam features only at L2/L3, opt-in per institution policy, processed by a vendor with a DPA, never used for emotion/"cheating-face" inference.
- Integrity signals are **evidence, not verdicts**: each flag carries an explanation ("pasted 1,240 chars at 00:14:03; no prior edits"), a confidence band, and the false-positive context. Final decisions are human, with an **appeals workflow** and audit trail.
- No LLM-text-detector as evidence. Similarity (AST/winnowing), edit-timeline anomalies, and **oral defence** are primary.
- Fairness monitoring: track flag rates by language/locale/institution; publish a methodology note.
- Candidate-facing transparency page: what is collected, why, for how long, how to appeal.

## 10. LLM-specific security (OWASP LLM Top 10 mindset)
- Prompt-injection assumption: **all candidate/customer text is hostile** to LLM graders. Use structured outputs (schemas), separate system/user content, no tool access, no secrets in prompts, outputs validated, LLM scores are *secondary signals* with calibration + human audit.
- Never send hidden tests/solutions of one tenant to a provider unless the contract allows; provider zero-retention settings; per-tenant allowlist for LLM use; all calls logged (redacted) with cost.
- Agent-under-test sandboxes cannot reach LLM provider keys; customers' model endpoints are called through the egress proxy with customer-provided short-lived credentials.

## 11. Privacy & compliance (build-in, not bolt-on)
GDPR/UK GDPR principles from day 1 (lawful basis, minimization, purpose limitation, rights: access/export/delete/rectify/object, DPA templates, sub-processor list, breach notification ≤ 72 h runbook). Children: exams may include minors in some jurisdictions; age gates and institution-controlled accounts. Regional laws (e.g. Bangladesh/India data-protection rules) tracked in `docs/compliance.md`. **SOC 2 Type I by month 12, Type II by 18–24**: map controls to the Trust Services Criteria; use a compliance automation tool; keep evidence in CI (access reviews, change management via PRs, restore drills, pentest reports, vendor reviews).

## 12. Security testing program
| Layer | Tool/Practice | Cadence |
|---|---|---|
| SAST | Semgrep (custom rules for our bans), CodeQL, `staticcheck`/`gosec` | every PR |
| Secrets | gitleaks pre-commit + CI | every push |
| SCA | osv-scanner, `pnpm audit`, govulncheck, Renovate | PR + daily |
| Container/IaC | Trivy, Checkov/tfsec for OpenTofu | PR |
| DAST | OWASP ZAP baseline + API scan against staging with OpenAPI | nightly |
| Authz matrix | Generated tests (endpoint × actor × tenant) | every PR |
| RLS matrix | Table × operation × two orgs | every PR |
| Fuzzing | Bundle/archive/markdown/checker-output parsers (Go fuzz, `jazzer.js`/fast-check) | continuous/nightly |
| Sandbox | Escape suite on every node + CI | boot, 6 h, deploy |
| Pentest | External (web/API) pre-launch & annually; **separate sandbox-escape pentest** | before first paid Forge delivery |
| Bug bounty | Private → public | by month 12 |
| Chaos/DR | Kill workers, drop DB connections, expire leases, restore from backup | monthly game day |
| Threat model | STRIDE per module, updated per stage in `docs/threat-model.md` | every stage |

## 13. Incident response
Severity matrix (SEV1 data breach / sandbox escape / credential-key compromise → page immediately), on-call rota, runbooks in `docs/runbooks/` (judge-node compromise: isolate node, revoke cert, rotate affected secrets, re-judge window; key compromise; tenant data exposure; DDoS during contest), status page, customer notification templates, blameless postmortems within 5 business days, regulator notification checklist.

## 14. Security gate (must pass at the end of EVERY stage)
- [ ] Threat model updated; new trust boundaries documented.
- [ ] All new endpoints in the authz matrix; all new tenant tables in the RLS matrix.
- [ ] SAST/SCA/secret/container scans green; no high/critical unresolved.
- [ ] Inputs: schemas + limits + fuzz targets for new parsers.
- [ ] Logging/audit events for security-relevant actions; no PII/secrets in logs (test).
- [ ] Rate limits and abuse cases defined and tested.
- [ ] Privacy review (new data collected? consent/retention/export/delete).
- [ ] Rollback and feature-flag plan.
- [ ] A human has read the diff of `identity`, `passport`, `judge`, `db/rls`, `infra` changes.
