# 10 — Testing and Quality Strategy

> Philosophy (TigerStyle): **assertions are the second program; simulation is the third.** We test what must never happen as seriously as what should. Deterministic reproduction of every failure is mandatory.

## 1. Pyramid and what each layer proves
| Layer | Tooling | Proves | Speed |
|---|---|---|---|
| Static | `tsc --strict`, Biome, tigerlint, depcheck, Semgrep | Types, limits, bans, import graph | seconds |
| Unit / pure rules | Vitest + fast-check | `rules.ts` state machines, scoring, rating, parsers | seconds |
| Integration (real Postgres) | Vitest + Testcontainers | SQL, RLS, constraints, transactions, queue semantics | tens of s |
| **Deterministic simulation (DST)** | in-repo `apps/api/src/sim` harness | Protocols under faults: lease/fencing, scoreboard fold, exam autosave, credential issuance, rating idempotency | minutes (many seeds) |
| Contract | Generated from Zod/OpenAPI; schema-diff check | No breaking changes; Go ⇄ TS protocol agreement | seconds |
| Component | Vitest + Testing Library + axe | UI behavior, a11y | seconds |
| E2E | Playwright (Chromium/Firefox/WebKit; mobile viewport) | Critical journeys | minutes |
| Judge | Go tests, golden task suites, escape suite on Linux/KVM runner | Verdict correctness, isolation | minutes |
| Load / soak | k6 scenarios | Capacity targets (file 05 §4) | scheduled |
| Security | See file 08 §12 | Vulnerability classes | per PR / nightly |

## 2. Definition of Done (every change)
1. Failing test written first (or a justification that the change is non-behavioral).
2. `pnpm check && pnpm test` green locally and in CI; zero warnings.
3. Assertions added for new invariants; limits named; negative-space tests (limit-1/limit/limit+1, unauthorized, malformed, replayed, concurrent).
4. DB changes: migration reviewed; RLS policy + matrix test; index + `EXPLAIN` for hot queries; expand/contract respected.
5. API changes: Zod schema, OpenAPI diff reviewed, authz matrix row, rate-limit class, idempotency decision.
6. Observability: structured logs, metric(s), trace spans, alert if it can break SLOs.
7. Docs: ADR if a decision was made; runbook if operations change; comments explain *why*.
8. Security checklist (file 08 §14) satisfied for the scope of change.
9. Rollback path stated in the PR (feature flag, revert-safe migration).
10. `craft` checklist satisfied: assumptions stated, simplest solution, **every changed line traces to the request** (no drive-by edits), verifiable success check, errors handled, names/comments/commit message explain *why* (file 02 §6).
11. Non-trivial tests carry a short goal-and-method comment; boundary tests cover the moment valid input becomes invalid.

## 3. Deterministic Simulation Testing (DST) — the harness
**Idea (from TigerBeetle's VOPR):** run the real logic against a simulated world — fake clock, fake network, fake disk/DB — driven by a seeded PRNG that injects faults and reorders events. A failing seed replays identically.

### 3.1 Harness design (`apps/api/src/sim/`)
- `World { clock, rng, net, db? }`: `clock.advance(ms)`, `rng.next()`, `net.send(from,to,msg)` with probabilistic **drop / duplicate / delay / reorder / partition**, node **crash/restart** (losing in-memory state, keeping the spooled state).
- Modules under test are written against ports (`Clock`, `Rng`, `Db`, `Net`) so the same code runs in prod and sim. The sim DB is an in-memory model that implements the same *semantics* for the queries involved (lease/complete predicates) **and** a mode that runs against real Postgres in a Testcontainer for the core scenarios (so the model can't drift: "model vs real" equivalence test).
- Scenario = `(seed, steps, fault_profile)`; runner prints `SEED=… SCENARIO=… STEP=…` on failure and writes a trace. `pnpm test:sim --seed=123456` reproduces.
- CI: 500 seeds per scenario per PR (≤ 3 min); nightly: 100,000 seeds; weekly: swarm with random fault profiles.

### 3.2 Required scenarios and invariants
| Scenario | Invariants asserted after every step |
|---|---|
| **Judge lease/fencing** (N nodes, M jobs, crashes, partitions, duplicate completes, clock skew within bounds) | Each job has ≤ 1 accepted completion; accepted completion's epoch = current epoch; no job lost (eventually `done` or `dead` after bounded retries); a stale completion never changes state; queue depth bounded |
| **Contest scoreboard** (random submissions/verdict order, rejudges, freeze/unfreeze, late verdicts) | Incremental state == fold(log); frozen view never reveals post-freeze events to public; ranks consistent with tie-break rules; penalty arithmetic matches reference implementation |
| **Rating** | Idempotent re-run yields identical output; permutation of equal ranks yields stable results; no NaN/∞; bounded rating change |
| **Exam autosave/sync** (flaky client, offline periods, duplicate/out-of-order saves) | Last accepted `seq` is monotone; no accepted save after `deadline_at`; recovered draft equals last acknowledged save; no data loss for acked saves |
| **Credential issuance & revocation** | One credential per (subject, event); status bit set ⇔ revoked; issued JWT verifies with the active/retired key set; re-run of issuance job is idempotent |
| **SSE resume** | Client with `Last-Event-ID` receives a gap-free monotone sequence or a `resync` |
| **Rate limiter / load shedding** | Never exceeds the configured bucket; fairness across actors |
| **Rejudge** | Current-verdict pointer moves atomically; history preserved; scoreboard recomputation correct |

### 3.3 Go side
The judge agent's scheduler and spool are written against interfaces (`Clock`, `Transport`, `Runner`) with a fake `Runner` that produces scripted verdicts/crashes; table-driven + fuzzed sequences test: crash between "result computed" and "ack received", duplicate delivery, lease expiry mid-run, disk full, control-plane outage > spool capacity (back-pressure, stop leasing).

## 4. Property-based & fuzz targets
- fast-check: scoring folds, rating math, pagination cursors (round-trip, tamper detection), markdown sanitizer (no script execution; idempotent), ID encode/decode, limit handling.
- Fuzz (Go native + `jazzer.js`/custom): bundle/tar/zip parser, spec parser, checker-output parser, meta-file parser (`isolate`), CSV roster import, markdown/KaTeX pipeline, JWT/VC verification inputs, SSE frame parser on client.
- Corpus stored in `tasks/fuzz-corpus/` (small, curated). Crashers become regression tests automatically.

## 5. Integration test rules
- Real Postgres via Testcontainers (same major as prod), one container per test file group, **template database + per-test schema or transaction rollback** for speed.
- Each test sets RLS context like a request would; a helper `asUser(user, org, fn)`.
- **RLS matrix test** (generated): for each tenant table and each operation, with org A and org B fixtures, assert B cannot SELECT/INSERT/UPDATE/DELETE A's rows; and that policies exist (query `pg_policies`) — fails when a new table lacks one.
- **Authz matrix test** (generated from route registry): each route × actors {anon, owner, same-org-wrong-role, other-org, API key wrong scope, suspended user} ⇒ expected status. A new route without a matrix row fails CI.
- **Migration tests:** apply all migrations to empty DB; apply to a snapshot of the previous release with realistic data (anonymized fixtures); verify rollbacks for expand steps; `drizzle-kit` drift check; lock-time check on big tables (no `ACCESS EXCLUSIVE` > 1 s; use `CREATE INDEX CONCURRENTLY`, `NOT VALID` then `VALIDATE`).

## 6. E2E journeys (Playwright, each runs against a full docker-compose stack with a dev-mode judge)
1. Sign up with passkey (virtual authenticator) → profile → join practice → submit AC and WA → see verdict stream.
2. Instructor creates exam → imports roster → student takes exam (autosave, reload mid-exam, offline/online toggle) → submit → grades appear.
3. Contest: 50 virtual users submit; scoreboard updates in order; freeze/unfreeze; export standings.
4. Forge: author uploads bundle → validation job → report → release → customer downloads delivery with watermark id logged.
5. Passport: credential issued → public `/verify` renders valid; revoke → page shows revoked within 60 s; tampered JWT shows invalid.
6. Tenant isolation smoke: user in org B cannot reach org A resources by URL manipulation.
7. Accessibility: axe scan on every route in the journeys; keyboard-only path through submit flow.
Flake budget: 0; a flaky test is quarantined within 24 h and fixed within a week.

## 7. Load & soak (k6 + a judge load generator)
- `contest-start-spike`: 5,000 users load scoreboard + problem pages within 10 s, then 100 submissions/s for 10 min; assert SLOs and zero lost submissions.
- `exam-wave`: 2,000 sessions autosaving every 5 s + telemetry batches for 2 h; assert p99 < 200 ms, DB CPU < 60 %.
- `sse-fanout`: 20,000 SSE clients on N instances; memory per connection bounded; slow-consumer shedding works.
- `judge-throughput`: replay a corpus of 10k real-shaped submissions; verdict latency and `SE` rate.
- Soak 24 h at 30 % load: no memory growth (> 5 %), no connection leaks, vacuum healthy.
Results are stored as CI artifacts with the git SHA; regressions > 10 % fail the nightly.

## 8. Judge correctness suites
- **Golden task suite** (`tasks/golden/`): 100+ tasks with known solutions in each language (AC), plus intentionally broken variants (WA/TLE/MLE/RTE/OLE/CE) with expected verdicts; run on every judge release and on every node weekly.
- **Cross-validation:** run a sample of submissions through an independent reference judge configuration (different checker implementation) for disagreement detection.
- **Timing calibration:** known-complexity programs to calibrate time multipliers per language/profile; alert on drift.
- **Escape suite:** file 07 §9.

## 9. Quality gates in CI (single pipeline, fast feedback first)
1. Install (frozen lockfile, no scripts) → 2. `check` (lint/types/tigerlint/depcheck) → 3. unit+property → 4. integration (Postgres) → 5. DST quick → 6. build all (web, api, judge) → 7. contract diff + generated-code diff → 8. security scans → 9. component + a11y → 10. e2e (parallel shards) → 11. image build, SBOM, sign → 12. deploy to staging (main only) → 13. smoke + ZAP baseline → 14. manual approval → prod. PR target ≤ 12 min wall time; nightly adds long DST, fuzz, load, DAST.
Coverage is tracked but **not** a goal on its own: mutation testing (Stryker on `rules.ts` modules) nightly with a target mutation score ≥ 80 % for pure domain logic.

## 10. Test data & fixtures
Deterministic factories (`makeOrg`, `makeUser`, `makeTaskBundle`) using the seeded `Rng`. No production data in lower environments; staging uses synthetic data generators. Golden bundles live in `tasks/` and are content-hashed in tests to detect accidental edits.

## 11. Bug policy
Every bug fix lands with a regression test (unit, property, or a sim seed pinned in `sim/regressions.ts`). Production incidents add a DST scenario or a fault profile if the failure was a distributed-systems one.
