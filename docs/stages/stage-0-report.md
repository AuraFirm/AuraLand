# Stage 0 report

## Scope delivered
Repository skeleton; strict TypeScript 7 workspace (api, web, contracts, db, tools); pnpm
supply-chain settings; Biome; `tigerlint` (12 rule groups, import-graph rules, waivers with
mandatory reasons); `depcheck` (exact pins, ADR per dependency, runtime budgets); platform
primitives (`assert`, `result`, `clock`, `rng`, logging, config, problem+json); API shell with a
fixed middleware order; web shell with per-request CSP nonce and static security headers; database
client, transaction-local RLS context and checksummed migration runner; deterministic-simulation
harness with seeded world; CI workflows, Dockerfiles, compose file; six ADRs; threat model v0;
`CLAUDE.md`, README and the `craft` skill in `.claude/skills/craft/`.

## Deferred or not done (with reasons)
| Item | Status | Why |
|---|---|---|
| Amd64 images | Not built | Verified on arm64 only (Colima); CI builds on amd64 |
| Staging deploy of a hello endpoint | **Not done** | No AWS account, region, domain or credentials; decisions D1, D3, D8 open |
| CI run on GitHub | **Not run** | Remote `origin` is registered (private repo `AuraFirm/AuraLand`) but nothing is pushed; workflow YAML parses but is unproven |
| SBOM, signing, provenance | Not done | Needs a registry and a deploy target; add with the first deploy |
| Branch protection, CODEOWNERS entries | Not done | Needs the GitHub repo and decision D9 (security reviewer) |
| OpenTelemetry, extra ports, worker role | Deferred | No consumer yet; ADR 0004 and 0006 |
| CSP exercised in a real browser | Not done | Playwright arrives with Stage 1 end-to-end tests |
| Claude Code listing the repo copy of the `craft` skill | Not confirmed | Needs a new session in this repo |

## Acceptance evidence
| Criterion | Evidence |
|---|---|
| Fresh copy → check, test, simulation green | Verified in a clean temp copy with `git init`: check exit 0, 71 tests passed, 500/500 seeds. (Without a git repository `tigerlint` fails loudly by design.) |
| Seeded simulation failure reproduces | `sim.test.ts` replays the failing seed and gets an identical failure |
| tigerlint catches seeded violations | `tigerlint.test.ts`, `tigerlint-imports.test.ts`; also caught 6 real violations in this code on first run, all fixed |
| depcheck catches violations | `depcheck.test.ts`; it blocked this very work until ADRs existed |
| RLS context isolates tenants and does not leak | `context.test.ts` on PostgreSQL 18.6; mutation check: with session-wide `set_config` the leak test failed, restored afterwards |
| API runs and shuts down cleanly | Built bundle served health, readiness (real database), 404 and 413 problem responses; SIGTERM exited 0 |
| Web headers and nonce | Standalone server: all static headers, unique nonce per request, nonce on 5 script tags, no `X-Powered-By` |
| Docker (added after first report) | Colima VM, Docker 29.5. `infra/compose.yml` starts healthy on PostgreSQL 18.6 (digest-pinned image); `pnpm test` passes 71/71 against it; both Dockerfiles build (API 352 MB, web 403 MB); containers run `--read-only --cap-drop ALL`, non-root (uid 1000); API `/api/readyz` is ready against the compose database; web serves the nonce CSP |
| Supply chain | `pnpm audit`: no known vulnerabilities; `pnpm audit signatures`: 234 packages verified; 3-day rule rejected two fresh versions; esbuild script denied explicitly |

## Test totals
71 tests in 10 files (tools 33, api 20 including the simulation harness tests, web 5, contracts 3,
db 10); simulation scenario run over 500 seeds.

## Key decisions and deviations
ADRs 0001–0006. Notable: kit corrections (pnpm settings location, root entry limit 14, no
Testcontainers, access-log position), TypeScript 7 forcing oxc-parser and `ignoreBuildErrors`.

## Security gate (docs/kit/08 section 14)
- [x] Threat model updated (v0)
- [x] Inputs: schemas and limits for config, request id, body size, RLS identities
- [x] Logging redaction configured; no PII exists yet
- [x] Supply-chain controls active
- [ ] Authz and RLS matrix tests: not applicable until Stage 1 tables exist
- [ ] SAST/CodeQL, secret scan, container scan: configured, not yet run
- [ ] Human read of `packages/db` and `infra` diffs: pending sign-off

## Risks and follow-ups (ranked)
1. CI and images are unproven until the first GitHub run; expect small fixes.
2. Node 26 becomes LTS on 2026-10-28; decide by ADR whether to move from 24.
3. Next.js advisory cadence remains high (ADR 0005); patch within 72 hours.
4. `tigerlint` depends on `oxc-parser`; watch for a stable TypeScript JS API.
5. Assertion failure stops the API process by design; Stage 1 must keep externally reachable input
   validation separate from invariants so attackers cannot trigger restarts.

## Questions for the humans
1. Create the GitHub repository and decide D9 (security reviewer) so CI, branch protection and
   CODEOWNERS can be switched on.
2. Choose cloud region, domain and legal entity (D1, D3, D8) to unblock the staging deploy.
3. Approve Stage 1, or ask for changes.
