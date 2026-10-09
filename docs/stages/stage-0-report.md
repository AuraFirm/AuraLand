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
| Staging deploy of a hello endpoint | **Deferred** (ADR 0008) | No AWS account, region, domain or credentials; D1, D3, D8 open. Stage 1 does not depend on it |
| CodeQL | Re-enabled | Was manual-only while the repo was private; the repo is now public, so it runs beside Semgrep (ADR 0007 amendment) |
| SBOM, signing, provenance | Not done | Needs a registry and a deploy target; add with the first deploy |
| OpenTelemetry, extra ports, worker role | Deferred | No consumer yet; ADR 0004 and 0006 |
| CSP exercised in a real browser | Moved to Stage 1 | Playwright arrives with the Stage 1 end-to-end tests (new dependency, needs its own ADR) |

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
| Repository protection | Ruleset on `main` is active with an empty bypass list: pull request, four required checks (strict), signed commits, linear history, squash or rebase only, no deletion or force-push. Two PRs merged through it; the unsigned one was blocked until commit signing was set up |
| GitHub security settings | Dependency graph, Dependabot alerts and security updates, private vulnerability reporting, secret scanning and push protection are enabled (verified with the API). Generic-secret patterns and validity checks cannot be enabled through the API (optional) |
| CodeQL | Re-enabled after the repo became public; its one finding (biased `nextInt`) was fixed in PR #2 and GitHub marked alert #1 fixed |
| `craft` skill and `CLAUDE.md` | A fresh headless Claude session in the repo listed `craft` and quoted the `CLAUDE.md` title. (`craft` also exists in the home folder, so this does not isolate the repo copy.) |
| Container scan | Trivy on both images and the Dockerfiles: 0 findings after switching to a distroless runtime (ADR 0009); it first found 4 npm and 7 Debian HIGH advisories in the old base |
| Docker (added after first report) | Colima VM, Docker 29.5. `infra/compose.yml` starts healthy on PostgreSQL 18.6 (digest-pinned image); `pnpm test` passes 71/71 against it; both Dockerfiles build (distroless runtime: API 225 MB, web 275 MB); containers run `--read-only --cap-drop ALL`, non-root (uid 65532), no shell; API `/api/readyz` is ready against the compose database; web serves the nonce CSP |
| CI on GitHub (first run, 2026-10-10) | `verify`, `images` (amd64) and `secrets` jobs succeeded. CodeQL analyzed everything but could not upload results (needs paid GitHub Code Security); replaced by Semgrep, ADR 0007 |
| Supply chain | `pnpm audit`: no known vulnerabilities; `pnpm audit signatures`: 234 packages verified; 3-day rule rejected two fresh versions; esbuild script denied explicitly |

## Test totals
71 tests in 10 files (tools 33, api 20 including the simulation harness tests, web 5, contracts 3,
db 10); simulation scenario run over 500 seeds.

## Key decisions and deviations
ADRs 0001–0010. Notable: kit corrections (pnpm settings location, root entry limit 14, no
Testcontainers, access-log position), TypeScript 7 forcing oxc-parser and `ignoreBuildErrors`.

## Security gate (docs/kit/08 section 14)
- [x] Threat model updated (v0)
- [x] Inputs: schemas and limits for config, request id, body size, RLS identities
- [x] Logging redaction configured; no PII exists yet
- [x] Supply-chain controls active
- [ ] Authz and RLS matrix tests: not applicable until Stage 1 tables exist
- [x] Secret scan (TruffleHog), SAST (Semgrep) and CodeQL pass in CI; container scan (Trivy) passes locally, CI run pending in this PR
- [x] Human sign-off: given by the founder on 2026-10-10 (recorded in the Sign-off section)

## Risks and follow-ups (ranked)
1. CI pulled images anonymously from Docker Hub and was rate-limited on shared runners; images now come from registries without that limit, digests unchanged (ADR 0010). The base image digest needs periodic refreshing (ADR 0009).
2. Node 26 becomes LTS on 2026-10-28; decide by ADR whether to move from 24.
3. Next.js advisory cadence remains high (ADR 0005); patch within 72 hours.
4. `tigerlint` depends on `oxc-parser`; watch for a stable TypeScript JS API.
5. Assertion failure stops the API process by design; Stage 1 must keep externally reachable input
   validation separate from invariants so attackers cannot trigger restarts.

## Decisions recorded on the founder's behalf (2026-10-10)
- D9: the security reviewer is the repository owner, `@ShifatHasanGNS` (CODEOWNERS).
- The staging deploy is deferred (ADR 0008). D1, D3 and D8 stay open.

## Sign-off
**Approved by the founder on 2026-10-10** (their words: "Stage 0 approved"), after the work merged
to `main` as PRs #1 to #3 with all CI checks green. The approval covers the stage as reported
above, including the deferred items and the deviations in ADR 0006. The staging deploy stays open
under ADR 0008. Stage 1 starts with a plan for review, not code.
