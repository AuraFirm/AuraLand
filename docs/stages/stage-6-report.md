# Stage 6 report: exams and integrity

Status: built, awaiting your review. Plan: [stage-6-plan.md](stage-6-plan.md). Decisions: `docs/adr/0032-stage-6-decisions.md`.
Runbook: [../runbooks/exams.md](../runbooks/exams.md). Slice 13 (LTI 1.3 against a mock) was optional and is **not built**.

## What exists
| Slice | What | PR |
|---|---|---|
| 0 to 1 | Plan, ADR, exam tables, state machines, deadline function with the injected clock, RLS | #99 to #101 |
| 2 to 3 | Exam setup, roster CSV, the candidate's sitting (join, consent as a condition, system check, start, server timer) | #102, #103 |
| 4 | Autosave that never loses an acknowledged save; simulation; offline drafts in the browser | #104 |
| 5a, 5b | Hand-in, judging at priority 2, results hidden until release; rubric grading, result, safe CSV export | #105, #106 |
| 6 | Consent-gated telemetry, closed kinds, partitioned, retention job | #107 |
| 7 | Live monitor, replay that rebuilds every saved text | #108 |
| 8 | Similarity by winnowing, review page | #109 |
| 9 | Integrity flags, human decisions, appeals with a different reviewer | #110 |
| 10 | `LlmProvider` port, strict schemas, oral defence (the model writes questions, a person scores) | #111 |
| 11 | Institution dashboard, draft attainment report, SEB design note | #112 |
| 12 | Scaled load run, ASVS rows, threat model v8, privacy and DPA drafts, runbook, this report | this PR |

## Verified (with evidence)
- **No acknowledged save is lost.** `exam-saves` simulation 500/500 seeds, mutation-checked (it fails if the deadline check or
  the commit-before-ack is removed); the SQL function agrees with the pure rule on 1,500 random requests around every edge; the
  load run below had 0 lost of 11,995 acknowledged saves.
- **Replay is exact.** Applying the saved steps reproduces the judged source byte for byte (3,000 random edit chains over
  CRLF, tabs, combining and astral characters, plus an HTTP test against the real submission).
- **Separation of duties is in the database.** 400 flags driven through 8 random operations by 4 kinds of people: every SQL answer
  equals the pure rules' prediction; removing the "reviewer is not the decider" check makes both that test and the HTTP test fail.
- **Hostile code cannot steer the prompt** or smuggle a score: 13 refused reply shapes, delimiter break attempts, hostile-model
  replies leave the request failed with nothing stored. **Verified against a scripted model only.**
- **Scaled load run** (`stage-6-load-2000.json`; one development machine, real API, worker and PostgreSQL over HTTP, no judge):
  2,000 people joined, agreed and started in 20 s (p95 about 10 ms); 11,995 saves (p50 7 ms, p95 14 ms, p99 26 ms); 3,995 telemetry
  batches; all with 0 errors; 2,000 hand-ins at once p50 2.1 s, p95 3.4 s; all 2,000 became judge jobs at priority 2, 19 s after
  the last hand-in. This is evidence of shape and headroom on one machine, not a capacity claim.
- Gates at the end: `pnpm check` clean; `pnpm test` 1,701 tests in 151 files; `pnpm test:sim` eight scenarios 500/500;
  `pnpm test:e2e` 42 browser tests (axe on every new staff page and the candidate screens); migrations 0044 to 0052.

## Not verified, not built
- **No real exam has run.** No deployment (F1), no reviewed judge node (F32), legal review of the privacy documents pending.
- **No real LLM call.** Oral defence was tested with a scripted model; no adapter exists (F56).
- Axe finds only what it can find: a human accessibility audit has not been done. The candidate's flag, appeal and oral-answer
  forms have HTTP tests but no seeded browser path (F60).
- Assurance above level 1 (identity proof, lockdown browser, proctoring): a design note only (F58).
- Similarity compares within one exam; "earlier exams of the course" needs a course concept (F55). The attainment report is a
  draft with a placeholder threshold (F59). Account-level deletion of exam data is open (F57). Hand-in surge numbers are from
  one process (F61). LTI 1.3 not built.

## Mistakes and fixes worth knowing
- A problem list was readable through another exam that shared a task version; fixed with a policy keyed to the person's own
  started sitting. A NUL byte in a draft was a 500; now a 400. A definer function created tables in `pg_catalog` until DDL was
  schema-qualified. The first simulation never crossed the deadline (insensitive); fixed by choosing deadlines on odd and even seeds.
- The similarity validation ran before the authorization check, so a stranger got a 400 where the matrix wanted a 404; reordered
  so who may ask is decided first.
- My first "unrelated programs" corpus for similarity was structurally identical after normalization (which is the point of
  normalizing); the test now uses random token soup.
- A replay's events missed anything before the first save or after the last; widened. A JavaScript maximum date is not readable
  by PostgreSQL; a named latest instant replaced it.
- ASVS rows: I removed five rows whose requirement numbers I could not check against the standard's text rather than guess.
- Registry rate limits failed CI twice (re-run); several tigerlint limits (function length, no `as`, no string SQL) forced splits.

## Decisions I made that you may overrule
1. Consent is a condition of sitting (versioned text); legal review may change that.
2. The model only writes questions; a person scores; with no provider, requests wait.
3. Appeals need a second admin; one-admin hosts cannot review.
4. Integrity thresholds (500-character paste, 10 focus losses, 0.8 similarity) are placeholders marked by `RULE_VERSION`.
5. The attainment report's 60% threshold is a named placeholder.

## Next
You: the list in `docs/owner-tasks.md` section 3.8. Engineering, when unblocked: F55 to F61, then Stage 7 per `docs/kit/12`.
