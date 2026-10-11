# Stage 3 plan: the job queue, submissions and the judge

Status: **approved on 2026-10-11 by the owner, who delegated every decision in it** ("take the best
possible decisions and continue working"). The decisions below are mine, recorded in ADR 0027, and
are the ones to challenge when you read this. Kit reference: `docs/kit/12` Stage 3, `docs/kit/07`
(judge and sandbox), `docs/kit/06` section 7 (node protocol), `docs/kit/08` section 4.

## 1. Goal
After this stage a person can submit source code to a released task and receive a verdict, produced
by an agent that leases work from the control plane, runs it in a sandbox on a judge node, and
reports back. The stage builds the reusable core of the whole platform: the **job queue** (leases,
fencing, retry, dead letters) with its simulation, the **submissions** data model and API, and the
**judge-node protocol**. It also closes the Stage 2 debts that need a worker: cleanup jobs, bundle
validation off the API host, re-validation of waived releases.

## 2. What can and cannot be verified in this environment (read first)
The development machine is macOS on Apple silicon. The sandbox (`isolate`, cgroup v2, seccomp,
namespaces) needs Linux, and the kit requires that untrusted code never runs on the API or web
hosts or on a developer's machine. So:
- **Built and fully tested here:** queue, worker, submissions, protocol (control plane and agent
  client), scheduling, verdict mapping, result handling, the agent against a **fake sandbox**.
- **Written here, verified only on Linux:** the `isolate` driver and the escape suite. They are
  tested in a Linux container where possible and always marked in the report as *not yet verified on
  a KVM-capable judge node*. **No public use of the judge, and no use with real participants, before
  that review** (kit gate: external review of the sandbox configuration).
- The report will say, for every sandbox claim, whether it was observed or only designed.

## 3. Decisions (my defaults, all recorded in ADR 0027)
1. **Queue in PostgreSQL** (`jobs` table, `FOR UPDATE SKIP LOCKED`), as the kit says; one queue for
   everything, routed by `queue` and `kind`.
2. **Node authentication: Ed25519-signed requests now, mTLS at the edge later.** A node enrolls with
   a one-time enrollment token an administrator creates; it then signs every request (method, path,
   timestamp, body hash). The signature check lives in the app, so it works without infrastructure;
   an mTLS terminator can be added in front without changing the protocol.
3. **Agent language: Go** (kit), in `judge/`, with a hand-written wire contract mirrored by shared JSON
   fixtures that both the TypeScript and Go tests read (no code generator yet).
4. **Execution is behind a `Sandbox` interface.** Implementations: a fake (tests), `isolate` (Linux).
   No other way to run code exists in the agent.
5. **Languages at launch: C++ and Python 3** (C and Java follow once the profile mechanism is proven).
   Profiles are versioned data (compiler flags, limits), not code.
6. **Bundle validation runs on a judge node.** The TypeScript validator is not ported to Go in this
   stage. The agent runs the validator through a pinned Node runtime *inside a sandbox box* on the node
   (the same box mechanism as user code). Until a Linux node exists this path is covered by tests with
   the fake sandbox only.
7. **Submissions:** practice context only (`context_kind = 'practice'`); contests, exams and Arena are
   later stages. Source up to 256 KiB, stored in the database; verdicts per test stored with the kit's
   columns. Only released task versions can be submitted to.
8. **Waived releases are re-validated** by a `task.validate` job once a node can run it; until then
   they stay marked `waived`.
9. **Rate limit for submissions:** 6 per minute per person per task (kit), plus queue-depth load
   shedding at 1,000 ready jobs.
10. **Hidden material never leaves the control plane except to an authenticated node** holding a lease
    for a job that needs it; the node gets a presigned bundle URL scoped to that job.

## 4. Assumptions
No new top-level folder except `judge/` (Go; ADR 0027). New TypeScript dependencies: none planned.
New Go dependencies: standard library only for the first slices. The worker is a second entry point
of the same API package (`AURA_ROLE=worker`), not a new service. Time uses injected clocks; all queue
logic is simulated before it is trusted.

## 5. Scope
**In:** jobs table and module, worker role and cleanup jobs, DST lease/fencing scenario, submissions
tables and routes, node enrollment and the `/judge/v1` protocol, bundle download URLs for nodes, the
Go agent (protocol client, scheduler, sandbox interface, fake sandbox, spool), verdict mapping,
`isolate` driver and meta parsing (verified on Linux where possible), language profiles, golden
verdict tests, basic submit screen and verdict panel, threat model v3, runbook, report.
**Out:** Firecracker/Tier-2, contests, exams, rating, interactive tasks, SSE streaming (polling for
now), the Go port of the validator, multi-region pools, node image builds and fleet deployment.

## 6. Work breakdown (one pull request each, tests first)
| # | Slice | Verify |
|---|---|---|
| 1 | `jobs` table, queue module (enqueue with dedupe, lease with `SKIP LOCKED`, heartbeat, complete, fail with backoff, dead letter, expiry sweep), memory and PostgreSQL stores with an equivalence test, simulation scenario with fencing | 500 seeds in CI, 100,000 nightly; mutation checks; two-worker race tests |
| 2 | Worker role and cleanup jobs (expired sessions, challenges, flows, invitations, rate-limit windows, finished uploads; F9, F24) | Database tests; job handler tests |
| 3 | Submissions: tables with row-level security, routes (create, get, list, source visible to owner), state machine, rate limits, enqueue | Authorization matrix, HTTP tests, hidden-material walk |
| 4 | Judge protocol: node table, enrollment, signed-request auth, lease long-poll, heartbeat, complete, fail, bundle URL | HTTP tests with a test node; replay and forgery tests; fencing tests |
| 5 | Go agent: protocol client, scheduler, spool, fake sandbox, verdict mapping, shared fixtures | `go test`; contract fixtures run on both sides; end-to-end with the real API and the fake sandbox |
| 6 | `isolate` driver, meta parser, profiles, escape suite | Meta parser and mapping unit tests here; driver and escape suite in a Linux container if feasible, otherwise marked unverified |
| 7 | Submit screen and verdict panel | Browser test against the fake sandbox |
| 8 | `task.validate` job (validator in a box), waived-release re-validation, threat model v3, ASVS rows, runbook, report | Security gate checklist |

## 7. Security design (key rules)
- Untrusted code runs only through the `Sandbox` interface on a judge node; the API and the worker
  never execute it, and a Semgrep rule bans `child_process` outside the agent.
- A node holds no cloud credentials. Its only identity is its keypair; every request is signed and
  time-bounded, with replay protection by a per-node nonce window.
- Results are accepted only with the current lease epoch, in the same SQL statement that checks it;
  a stale node cannot overwrite a newer result.
- Verdicts are data from an untrusted machine: the control plane validates schema and bounds,
  truncates and strips control characters from any text, and treats a node that returns impossible
  values as faulty (job to `dead` after repeated poison results).
- System errors (`SE`) are never shown as the person's fault and are retried on another node.
- Hidden tests, jury answers and checker output are never in any response to a participant.

## 8. Invariants
1. A job is leased by at most one node at a time; its epoch increases on every lease.
2. A completion or failure with a stale epoch changes nothing.
3. A job reaches `done` or `dead` exactly once; retries never exceed `max_attempts`.
4. A submission's verdict is set once, by a completion that carried the current epoch.
5. Every `ready` job is eventually leased if a healthy node exists (no starvation across queues).
6. No response to a participant contains hidden material.

## 9. Limits (named constants in `limits.ts`)
Lease TTL 30 s, heartbeat every 10 s, long-poll 25 s, attempts 5, backoff 5 s doubling to 5 min,
source 256 KiB, tests per submission 1,000, per-test output cap 64 MiB, checker message 2 KiB, 6
submissions a minute per person per task, queue-depth shedding at 1,000 ready jobs, enrollment token
life 1 hour, request signature skew 60 s.

## 10. Failure modes (summary)
Node dies mid-job; node returns after its lease expired; two nodes complete one job; replayed or
forged request; clock skew; database failover during lease; poison submission crashing every node;
storage outage during bundle fetch; oversized or malformed result; node reports impossible times.

## 11. Things only you can provide, and when
- Before any public use: a Linux judge host with KVM (kit D-items), an external review of the sandbox
  configuration, and mTLS termination at the edge. Not needed for development.
- At the end: sign-off, and a human read of the protocol auth code and the sandbox driver.

## 12. Implementation log
- **Slice 1:** migration 0015 (`jobs`, new role `aura_worker`), `modules/jobs` (rules, store port,
  PostgreSQL store, service), in-memory store, `jobs` simulation scenario, equivalence test between the
  two stores over 12 seeds, concurrency tests (8 workers drain 60 jobs exactly once; two simultaneous
  completions, one wins). Faults injected into both stores were all caught; the simulation originally
  did not check that a non-retryable failure goes straight to `dead`, which a mutation exposed.
- **Slice 2:** the worker. `AURA_ROLE=worker` runs the same image and bundle (`main.ts` now only picks
  `http-main.ts` or `worker-main.ts`). Migration 0016: `cleanup_expired` (bounded deletes of expired
  sessions, sign-in challenges, OAuth flows, passkey challenges, rate-limit windows, old invitations,
  finished uploads and finished jobs), `expired_uploads` and `close_upload`, all `SECURITY DEFINER` and
  executable only by `aura_worker`. The worker leases from the queue, heartbeats while a handler runs,
  retries throwing handlers with backoff, fails unknown kinds for good, and schedules the two recurring
  housekeeping jobs without duplicating them. Closes F9 (cleanup) and the abort half of F23/F24; deleting
  storage objects of removed organizations is still open. Run against the real dev database: both jobs
  completed.
- **Slice 3:** submissions. Migration 0017 (`submissions`, `verdict_details`, forced RLS, guard trigger,
  `enqueue_judge_job` so the submission and its judge job commit together and a full queue refuses
  the whole request). Routes: create (members of the task's organization, released versions, languages
  the spec allows, 6 a minute per person per task), read one (own source and per-test results, no
  checker messages), list mine. Source up to 256 KiB: the general 256 KiB body cap would have cut valid
  submissions off, so that one route gets a larger transport cap and the schema enforces the real limit
  (found by a test). Full queue: 503 with `Retry-After` and nothing left behind. Cutlist F29 records
  that the `SECURITY DEFINER` functions need an owner role that can bypass row-level security.
- **Slice 4a:** judge nodes and their authentication. Migration 0018 (`judge_nodes`, single-use
  `node_enrollments`, `node_nonces`; administrator-only `create_node_enrollment` and `revoke_judge_node`;
  housekeeping extended). Routes under `/api/judge/v1`: enroll (token spent once, 10 tries a minute per
  address), node heartbeat (a passing self-test activates, a failing one drains). Every node request is
  an Ed25519 signature over method, path and query, timestamp (60 s skew), single-use nonce and body
  hash; all failures give the same bare 401; the nonce is spent in its own committed transaction so a
  request that failed cannot be repeated. A shared signature vector (`judge/fixtures/signature.json`)
  is for the Go agent. Mutation checks caught every fault but one (method binding), now covered by a
  unit test.
- **Slice 4b:** the judging loop. Routes under `/api/judge/v1`: lease (long poll up to 25 s as a series
  of short looks, never an open transaction), job heartbeat, complete, fail, bundle download (302 to a
  5-minute attachment URL, only for a node holding a live lease on a job for that bundle). Results are
  checked against the spec by `summarize` (pure, tested): the control plane decides the overall verdict,
  binary tasks stop at the first failure, other scoring needs every test, impossible reports and system
  errors go back to the queue for another node and are never shown to the participant. Checker messages
  are stored with control characters stripped and never returned to participants. Bugs found by the
  tests: a lease that expired left the submission "judging", so the re-leased job was skipped as already
  started (now accepted); the worker role lacked read access to the spec and audit insert (migration
  0019, column-level and kind-restricted). A node's long poll holds no database connection while it waits.
