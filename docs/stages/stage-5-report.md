# Stage 5 report: contests, the Arena, ratings

Status: **built, ready for your review.** Plan: [stage-5-plan.md](stage-5-plan.md) (you said "defaults, go ahead").
Decisions: [ADR 0031](../adr/0031-stage-5-decisions.md) and its amendments. Runbook: [../runbooks/contests.md](../runbooks/contests.md).
Everything that ran a sandbox ran on **one development VM**; the load run is **one development machine** with no judge.

## Read this first: what is verified and what is not
| Claim | State |
|---|---|
| Open participation: a registered person reads exactly their contest's problem statements from the start until finalizing, never before; organizers and problem authors cannot compete; contest submissions exist only through one database function with the injected clock | **Verified** (database tests, HTTP tests, RLS matrix, 1,200-case clock equivalence between TypeScript and SQL) |
| The scoreboard is a pure, order-independent fold; ICPC and IOI; freeze; total ranks; stored boards change only when their etag does | **Verified** (property tests with 500 seeds, simulation `scoreboard` 500 seeds, a deliberately broken fold is caught, database-backed tick tests) |
| Live updates: snapshot with ETag/304 and gzip, ping stream over Postgres NOTIFY with caps, keepalive and a 30-minute lifetime | **Verified** by tests; **"Live" through the real edge and the Next proxy is not** (F48); the page falls back to a 15-second poll |
| Unfreeze, rejudge (the old verdict keeps counting until the new one lands), clarifications (plain text, answered once), ICPC Contest API export | **Verified**; the export's golden test is the specification's own example, **not tested with a real ICPC tool** |
| Ratings: rated once per contest, oldest first, under a lock, history immutable, public profiles only | **Verified** (property tests, database tests, replay simulation). **The function is ours, not a port of Elo-MMR, and uncalibrated**; no independent vectors exist (F50) |
| Arena screens, practice bank, daily pick, status banner | **Verified** in a real browser with axe (33 browser tests). The practice bank has **no content** until you add some (F53) |
| C and Java 21 are judge languages | **Observed on the development VM only**: escape suites pass for cpp, c, java; each language builds and runs a real program. **No production node, no external review (F32).** Java's allowances are my defaults (F51) |
| The kit's load target (5,000 people in 10 s, then 100 submissions/s for 10 min) | **Not met on one process, and not run at full length.** See below |
| A real contest, real people, an edge, a deployment, a judge fleet | **No** (F1, F32, F33, F49) |

## What was built (pull requests #78 to #97, plus the one that carries this report)
5A: plan (#78), ADR and contract (#79), contests, registration, clock (#80), organizer API and screens (#81), contest
submissions (#82). 5B: scoreboard fold (#83), stored boards and the tick (#84), snapshot and ping stream (#85), unfreeze
and rejudge (#86), clarifications (#87), ICPC export (#88). 5C: ratings (#89), profiles (#90). 5D: problem and time API
(#91), Arena screens (#92), practice bank (#93), status banner and practice screens (#94), C (#95), Java (#96), load
harness with its two fixes (#97), threat model v7, ASVS rows, runbook, this report.

## The load run, as what it is
A real built API and worker over real HTTP, real PostgreSQL, on an Apple M1 (8 cores, 8 GB), Postgres in the Colima VM.
No judge runs, so verdict latency and judge throughput are **not measured**. Results are in `stage-5-load-*.json`.

| | 2,000 people: 6,000 reads in 10 s, then 100 submissions/s for 60 s | 5,000 people: 15,000 reads in 10 s, then 100/s for 60 s |
|---|---|---|
| the spike finished in | 10.0 s | 19.3 s |
| reads p50 / p95 / p99 | 8 / ~125 / ~173 ms | 2.9 to 4.1 s / 4.9 s / 5.1 s |
| submissions p50 / p99 | 9 / up to 40 ms | 10 / up to 67 ms |
| errors / lost submissions (accepted = rows = priority-1 jobs) | 0 / 0 | 0 / 0 |
| scoreboard versions in 60 s | 54 | 47 |

So: **2,000 people at once is comfortable on one process; 5,000 queues** (about 780 reads a second sustained). The design
answer is the edge cache plus several instances, which this stage cannot test. The first run at 2,000 was far worse
(reads p50 13.7 s, the spike took 44 s) before the fixes below.

## Found and fixed on the way (by tests and the load run)
- **A latent deadlock older than this stage:** a handler holds a pooled connection and the rate limiter opens a second one,
  so ten concurrent handlers on a pool of ten could never proceed and the API wedged for good. Now at most half the pool is
  inside handlers, with a bounded line (503 past it). A test with 60 concurrent requests hangs without the gate and passes with it.
- Every read of a stored board re-parsed and re-serialized it (what made the first load run slow); now etag-first, 304, cache, gzip.
- The ICPC export's ETag ignored the contest's state (a stale 304 was possible); it now covers it.
- An organization member who submitted to a problem of a live contest on the practice route got a 500 (my slice 3 guard); now 409.
- An anonymous reader of clarifications crashed the response (`app_user()` is null); caught by the test, fixed with `coalesce`.
- Two simulation/harness mistakes of my own (a tie rule that depended on log order; a load generator that re-sent accepted runs) were
  fixed by deciding the rule ("a rejected run at the very instant of the accept does not count against it") and correcting the generator.
- One cold run of the C++ memory bomb ended by time limit, not memory (contained; three reruns MLE). Recorded in the judge runbook, not loosened.
- Registry rate limits failed CI jobs twice; they pass on re-run.

## Decisions I made that you may overrule (also ADR 0031 amendments)
1. The scoreboard tick **rebuilds from the log** when its input stamp moves, rather than folding a delta (out-of-order judging and
   rejudges make a delta miss changes). The fold is tested equal to incremental application, so a delta can come later.
2. Streams carry **pings, not boards**, and need no ring buffer: a missed ping collapses into the newest, the snapshot is the truth.
3. A rated contest must be **public** (a rating history names its contests).
4. The practice bank is a **separate listing** with definer functions, so the staff routes for tasks stay closed to strangers.
5. Java: +1 s CPU/wall for the JVM, 64 MiB of the limit reserved for it (the cgroup limit never raised), a class named `Main`.
6. Ties: ICPC ranks duplicate on equal solved and penalty in the export; our own ranks are total (registration order last).
7. Kit paths differ: the stream is `/contests/:id/scoreboard/stream`, the export `/contests/:id/standings.icpc.json`.

## Not built (see cutlist F47 to F54)
Screens for answering clarifications, rejudging, unfreezing, the banner and bank curation (API only; the runbook shows how);
extending or cancelling a published contest; a second approver for finalizing; team contests and other formats; identity proof and
AI-policy enforcement; the rating's calibration; the faster rating algorithm above 20,000 people.

## Evidence at the end of the stage
`pnpm check` clean; `pnpm test` 1,499 tests in 126 files (up from 1,317 in 103); `pnpm test:sim` seven scenarios 500/500 (new:
`scoreboard`, `rating`); web build passes; `pnpm test:e2e` 33 browser tests passing (up from 25); Go tests green; `go test -tags
isolate ./internal/isolate` (escape suite per language and `TestLanguages`) passes on the Colima VM; migrations 0033 to 0043.

## Next
Stage 6 (exams and integrity) per `docs/kit/12`. Before any real contest: F1, F32, F33, F49 and a rehearsal with the runbook.
