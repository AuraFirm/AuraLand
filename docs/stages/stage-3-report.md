# Stage 3 report: the job queue, submissions and the judge

Status: **ready for your review, with one gate that cannot be passed on this machine.** Everything
that can be verified without running untrusted code is built and tested. **The sandbox has not been run
and the judge must not be used with real participants** until a Linux judge node passes the escape suite
and the sandbox configuration has had its external review (kit gate, cutlist F32). The plan
(`stage-3-plan.md`) and ADR 0027 record that you delegated every decision of this stage to me; they are
the decisions to challenge.

## Read this first: what is verified and what is not
| Claim | State |
|---|---|
| Queue: leases, fencing, retry, dead letters | **Verified.** Simulation (100,000 seeds run), memory and PostgreSQL stores proven equivalent, real-concurrency tests, mutation-checked |
| Worker and housekeeping | **Verified** against a real database and the dev database |
| Submissions: create, queue, read, list, limits, load shedding | **Verified** (HTTP tests, row-level security, authorization matrix) |
| Judge protocol: enrollment, signed requests, lease, heartbeat, result, bundle URL | **Verified**, including a **Go agent running against the real TypeScript app** and the verdict read back from PostgreSQL |
| Verdict and score computed by the control plane from the spec | **Verified** (`summarize`, 8 rules tests, HTTP tests) |
| Submit screen and verdict panel | **Verified in a real browser.** The browser test settles the submission in the database because no judge node exists there: it tests the screen, not judging |
| **isolate driver, escape suite, language profiles' real compilers** | **Written, compiled for Linux, pure parts unit-tested. NEVER RUN in a sandbox.** I built isolate v2.1.1 in a Linux container; it needs a systemd-delegated cgroup which a plain container lacks |
| **Any code ever executed by the judge** | **None.** The agent has a fake sandbox for tests; `aura-judge run` refuses to start without a real one |
| Bundle opening on a node, `task.validate`, re-validating waived releases | **Not built** (F30, F31): they need the sandbox |

## Scope delivered
| Area | What exists |
|---|---|
| Database | Migrations 0015 to 0019: `jobs` (new role `aura_worker`), cleanup functions, `submissions`, `verdict_details`, `judge_nodes`, `node_enrollments`, `node_nonces`, worker read grants and worker-kind audit inserts |
| Queue | `modules/jobs`: enqueue with dedupe, lease with `SKIP LOCKED` and an epoch, heartbeat, complete, fail with backoff, dead letters, expired-lease sweep; memory and PostgreSQL stores; `jobs` simulation scenario |
| Worker | `AURA_ROLE=worker` from the same image; cleanup of expired rows (closes F9) and abandoned uploads (part of F23/F24) |
| Submissions | Create (members, released versions, spec languages, 6 a minute per person per task, 503 when the queue holds 1,000 ready jobs), read one, list mine; verdict and per-test results without checker output |
| Judge protocol | `/api/judge/v1`: enroll (admin-created single-use token), heartbeat (self-test activates or drains), lease (long poll without an open transaction), job heartbeat, complete, fail, bundle download (302 to a 5-minute attachment URL for the lease holder); every request Ed25519-signed with nonce and timestamp |
| Go agent | `judge/` (standard library only): strict wire types, signing equal byte for byte to the TypeScript vector, signed client, `Sandbox` interface and fake, judging pipeline with built-in checkers, agent loop, isolate driver (unrun), 15 escape programs |
| Web | Submit form and verdict panel on a released version's page |
| Documents | ADR 0027, threat model v3, ASVS mapping for V4 and V12, judge runbook, cutlist F29 to F39 |

Slices as merged: 0 plan (#36), 1 queue (#37), 2 worker (#38), 3 submissions (#39), 4a nodes (#40), 4b
lease/results (#41), 5 Go agent (#42), 6 isolate driver (#43), 7 screens (#44), 8 (this pull request).

## Deferred or not done (with reasons)
See `docs/cutlist.md` (F29 to F39 are new). Most important:
| Item | Why |
|---|---|
| Run the escape suite on a Linux judge node; external sandbox review (F32) | Needs hardware and a reviewer; **blocks any real use** |
| Bundle opener in the agent and `aura-judge run` (F31); `task.validate` and waived re-validation (F30) | Depend on the sandbox |
| TLS/mTLS edge (F33) | No edge exists; most ASVS V12 rows are open until it does |
| Alerts and dashboards (F39) | No deployment |
| Custom checkers, interactive tasks, language/capacity scheduling, borderline re-runs, contexts beyond practice (F35 to F38) | Later stages |

## Key decisions and deviations from the plan and kit
ADR 0027 (queue in PostgreSQL; Ed25519-signed requests now and mTLS at the edge later; Go agent with a
hand-written wire contract and shared fixtures; execution only behind a `Sandbox` interface; C++ and
Python; bundle validation in a box via the existing TypeScript validator; practice contests only; no
sandbox claim without observation).
- **The vertical slice that needed Linux was written but not run** (see the top). This is the largest
  deviation and it is deliberate: the alternative was running hostile code on a developer machine.
- **Verdicts are decided by the control plane**, not reported by the node (not in the kit): a node only
  reports per-test results.
- **A lease that expires returns the job to the queue after a backoff**, and the submission stays
  `judging` until re-leased, so a re-leased job is accepted in that state (a bug the tests found).
- **`aura_worker` is a third database role** with column-level reads and worker-kind audit inserts only.
- The `SECURITY DEFINER` housekeeping functions need an owner that can bypass row-level security in
  production (F29).
- Small fixes along the way, each in its pull request: transport body cap for the source route only,
  simulation test timeouts, the shared flake in the presigned-download expiry test.

## Test evidence
| Check | Result |
|---|---|
| `pnpm check` (Biome, tsc, tigerlint, depcheck) | clean |
| `pnpm run check:go` (gofmt, vet, Linux vet with the isolate tag, tests) | clean; 31 Go tests |
| `pnpm test` | 1,089 tests in 79 files, all green (needs PostgreSQL, Mailpit, the local S3 server and Go) |
| `pnpm test:sim` | 500/500 seeds for each of 5 scenarios in CI; `jobs` 100,000/100,000 run locally on 2026-10-11; nightly runs a new block of 100,000 |
| `pnpm test:e2e` | 22 tests in real Chromium (task screens and the verdict panel included) |
| Cross-language | Go signs what TypeScript verifies (shared vector); both decode the same JSON fixtures strictly; a TypeScript test runs the Go agent against the real app |
| Mutation checks | Faults injected into both queue stores, the PostgreSQL queries, the node authentication and signing, the lease and result routes, the verdict rules and the cleanup functions. Survivors were either equivalent or turned into tests (for example: method binding in signatures, `dead` for non-retryable failures, creating a submission on an unreleased version) |
| Real defects found by tests | Expired-lease job skipped as "already started"; worker role missing read and audit privileges; the general body cap cut valid 256 KiB sources off; signature test starved by the enrollment rate limit; a recursion in a test; flaky presigned-download expiry under load |

## Security gate (docs/kit/08 section 14)
- [x] **Threat model updated.** `docs/threat-model.md` v3, including what is *not* claimed.
- [x] **New endpoints in the authz matrix / node routes covered.** 63 `/api/v1` rows (4 new admin and submission rows); every `/judge/v1` route except enrollment is checked for signature.
- [x] **Scans green.** Semgrep, CodeQL, TruffleHog, Trivy, `pnpm audit` in CI; Go has no third-party dependency.
- [x] **Inputs: schemas and limits; fuzz targets for new parsers.** All bodies strict; the meta parser is strict and bounded and unit-tested; the wire decoder rejects unknown fields and trailing data. No new binary parser exposed to hostile input.
- [x] **Audit events.** Submission created and judged (verdict, score, node), node enrollment created, node revoked.
- [x] **Rate limits and abuse cases.** Submissions 6/min per task, enrollment 10/min per address, queue shedding, bounded attempts.
- [x] **Privacy review.** Threat model v3.
- [x] **Rollback plan.** Additive migrations; judging off by revoking or draining nodes; runbook section 8.
- [ ] **A human has read the diffs** of the queue, node authentication, result handling, migrations 0015 to 0019, and the isolate driver. Not something I can tick. Reading order below.
- [ ] **ASVS V4 and V12 signed off by a human.** `asvs-matrix-stage-3.md`: 7 met, 6 partial, 5 not met, 10 not applicable of 28; nearly every open row is "the edge does not exist yet".
- [ ] **Sandbox gate.** External review of the sandbox configuration and a passing escape suite on a Linux node (F32). **Not done.**

## Known issues, risks and follow-ups (ranked)
1. **The judge cannot judge.** No sandbox has ever run. Treat the whole execution path as untested.
2. **Bundles are still not parsed anywhere** (F30, F31), so uploaded bundles remain unverified beyond size and hash; waived releases cannot be re-validated yet.
3. **The edge (TLS, HTTP/2, certificates) does not exist**, so the node protocol's transport is unprotected beyond its own signatures.
4. **`SECURITY DEFINER` functions assume a row-level-security-bypassing owner** (F29): check this before the first deployment.
5. **No alerts** on dead jobs, lease-expiry spikes or node failures (F39).
6. Items from the Stage 1 and Stage 2 reports still stand.

## Operational readiness
- Dashboards and alerts: none (no deployment, F1, F39).
- Runbook: `docs/runbooks/judge.md` (worker, queue inspection, enrolling and revoking nodes, suspicious results, what a node must pass before it takes work, rollback).
- Rollback: redeploy the previous image; migrations are additive.

## Metrics vs targets
| Target (kit) | Result |
|---|---|
| Golden suite verdicts exact on a KVM-capable runner | **Not measured**: no sandbox |
| Escape suite all contained | **Not run** |
| Lease/fencing simulation, 100k seeds nightly | Done (100,000 run locally; nightly job runs the registered scenarios) |
| Load test 100 sub/s for 10 minutes, p95 < 4 s | **Not measured**: no sandbox, no deployment |
| Chaos: kill agent mid-job, job re-leased and completed once | Covered in HTTP tests and the simulation (node goes silent, lease expires, another node completes, the first node's late answer is refused); not as a process-kill test |

## Suggested reading order for the human review
1. `packages/db/migrations/0015_jobs.sql`, `0017_submissions.sql`, `0018_judge_nodes.sql`, `0019_worker_reads.sql`.
2. `apps/api/src/modules/jobs/` (`queries.ts`, `rules.ts`, `service.ts`).
3. `apps/api/src/modules/judge/` (`node-auth.ts`, `signing.ts`, `job-routes.ts`, `routes.ts`, `admin-routes.ts`).
4. `apps/api/src/modules/submissions/` (`rules.ts`, `routes.ts`).
5. `judge/internal/` (`sign`, `client`, `judge`, `agent`, then `isolate`).
6. `docs/security/asvs-matrix-stage-3.md`, `docs/threat-model.md` v3.

## Your remaining manual tasks
- [ ] Read the code above and challenge ADR 0027's decisions; reply "Stage 3 approved" or list changes.
- [ ] **Provide or approve a Linux judge host** (KVM, systemd, cgroup v2) so the escape suite can run, and commission the external review of the sandbox configuration (F32). Nothing about real judging is safe before this.
- [ ] Decide when to build the edge (TLS, certificates) and the staging deployment (F1, F33).
- [ ] Still open from earlier stages: OAuth apps (F11), mail provider (F12), Turnstile (F7), the weekly `pnpm audit:verify` until F8.
