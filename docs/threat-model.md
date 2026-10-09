# Threat model (v0, Stage 0)

Updated every stage (docs/kit/08 section 14). Stage 0 has no user data and no authentication, so
this version covers the shell, the build pipeline and the database context pattern.

## Assets
Source code and lockfile integrity; CI and cloud credentials (none exist yet); the future tenant
data protected by the RLS pattern; availability of the health endpoints.

## Trust boundaries
Internet → edge (not built) → web (Next.js, renders UI, holds no secrets) → API (will hold DB and
KMS access) → PostgreSQL. The judge fleet and untrusted code execution do not exist yet.

## STRIDE for the Stage 0 surface
| Threat | Surface | Control | Evidence |
|---|---|---|---|
| Spoofing a request id to poison logs | API request id | Inbound `X-Request-Id` accepted only when the edge is trusted, charset and length checked | `app.test.ts` |
| Tampering with applied migrations | Migration runner | SHA-256 per migration, edit after merge rejected, database ahead of code rejected | `migrate.test.ts` |
| Repudiation of admin actions | Audit log | Not built; Stage 1 | n/a |
| Information disclosure through errors | API errors | RFC 9457 responses with a closed code set; internal causes only in logs; `.strict()` problem schema | `app.test.ts`, `errors.test.ts` |
| Identity leaking across pooled connections | RLS context | Transaction-local `set_config(..., true)`; leak test on a single reused connection; mutation-checked | `context.test.ts` |
| Denial of service by large or slow requests | API | 256 KiB body cap, header and request timeouts, 503 on unready database | `app.test.ts`, `limits.ts` |
| Elevation through framework bugs | Next.js | Thin renderer rules, no auth in proxy, no image optimizer, no ISR, nonce CSP | ADR 0005, `csp.test.ts` |
| Supply-chain compromise | Dependencies, CI | Exact pins, 3-day release age, no unreviewed install scripts, exotic sources blocked, trust policy, depcheck budget, audit and signature checks, pinned action SHAs | `pnpm-workspace.yaml`, `depcheck.test.ts` |
| Secrets in the repository | Git | `.env` ignored, TruffleHog in CI (not yet run) | `.gitignore`, `ci.yml` |

## Known gaps (accepted for Stage 0)
No TLS termination or WAF (edge not built). CSP not yet exercised in a real browser. CI workflows
and container images have not run. No rate limiting (arrives with authentication in Stage 1).
