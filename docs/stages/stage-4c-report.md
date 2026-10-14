# Stage 4C report: per-delivery watermarks and the leak trace

Status: **built, ready for your review.** Plan: [stage-4c-plan.md](stage-4c-plan.md) (you said "pick best
opinions and options; and proceed", which I took as accepting its defaults). Decisions: [ADR 0030](../adr/0030-stage-4c-decisions.md).
Everything that ran a sandbox ran on **one development VM**; model calibration and agent attack runs are
still not built (they need a provider account).

## Read this first: what is verified and what is not
| Claim | State |
|---|---|
| Each delivered bundle carries a mark that differs per delivery: trailing spaces on answer lines (whitespace-blind checkers, at least 64 lines) and a comment in each solution; test inputs are never touched | **Verified** (`watermark.test.ts`, a 200-bundle property sweep: tokens never change, tags round-trip) |
| The rewrite happens in a box on a judge node, from a validated bundle, and is validated again | **Verified in a real sandbox** (`rewriter_isolate_test.go`: the mark is in the delivered solution, inputs untouched, the result opens in a second box; a zip bomb, a symlink and a missing statement are refused) |
| A rewrite ships only if every verdict, mutant and attacker outcome is identical to the original's | **Verified**: rules tests; and in a real sandbox (`watermark_isolate_test.go`): 6 runs, 1 mutant and 10 attackers identical before and after |
| The tag is computed by the database from a secret and cannot be chosen by a node; the API measures the uploaded bytes itself | **Verified** (database tests, `http-watermark.test.ts`) |
| Manifests and download links use the delivered bytes; a ready delivery without a recorded bundle is an error, never a fallback to the original | **Verified** (`handlers.database.test.ts`, `http-deliveries.test.ts`, browser tests) |
| A leaked file names its delivery: verbatim, one file, a fragment (as "possible"), answers whitespace-normalized (the solutions still name it); nothing is found when answers and comments are both scrubbed or the files were never marked; 500 unrelated deliveries give no false match | **Verified** (`trace.test.ts`, `trace-leak-cli.test.ts`) |
| The acceptance run: 20 released versions for one customer, 3 of the same versions for another, real API + worker + agent, buyers download over HTTP with sessions, the customer script passes, the access log has 20 rows, 23 bundles recorded with 23 distinct tags, all marked and re-checked, and the two customers' copies differ byte for byte | **Verified once**, on the development VM: `node apps/api/src/pack-e2e-cli.ts` printed ACCEPTED. It is a developer tool, not CI |
| A leaker who normalizes whitespace and strips comments defeats the marks | **True, and stated** (tested; the methodology page and threat model say so) |
| Exact-checker tasks without solutions in the bundle are marked beyond the statement canary | **No.** No safe carrier exists; the manifest says which marks each copy carries |
| The 20 tasks of the pack run are 20 different authored tasks | **No.** They are 20 versions of one test bundle |
| A real customer, payment or deployment | **No** (D1, F44, F1) |

## What was built (pull requests #71 to the one that carries this report)
Plan (#71); watermark module and ADR 0030 (#72); the rewriter in a box (#74); the watermark job from
order to recorded bundle, migration 0031 (#75); manifests and downloads on the delivered bytes, migration
0032 (#76); the leak trace and its tool, the 20-task acceptance run, threat model v6, runbook, methodology
text (the next pull request).

## Decisions I made that you may overrule
1. The tag has its top bit always set (31 bits of identity) so an unmarked bundle is not read as a mark.
2. "Strong" evidence is an exact solution tag or 24 agreeing answer bits; 8 to 23 bits is "possible"; the
   answer evidence also needs at least 2 ones, because a run of zeros is silence.
3. The leak trace reads loose files only; a leaked archive must be opened in a box first.
4. Tasks whose harness cannot run (custom checker, interactive) get a solutions-only mark without a
   verdict re-check, recorded as `verdicts_checked = false`; answers are never marked there.
5. A dead watermark job leaves its delivery pending; recovery is manual for now (F39).

## Found and fixed on the way
- A stacked pull request is closed, not retargeted, when its base branch is deleted by the merge.
- The ADR 0003 ownership-map test caught `delivery_bundles` missing from the document (fixed).
- Registry rate limits (`toomanyrequests`) failed CI jobs several times; they pass on re-run.

## Evidence at the end of the stage
`pnpm check` clean; `pnpm test` 1,317 tests in 103 files (up from 1,262 in 96); `pnpm test:sim` five
scenarios 500/500; web build passes; `pnpm test:e2e` 25 browser tests passing; Go tests green;
`go test -tags isolate` for `internal/bundles` and `internal/watermark` passes on the Colima VM; the
20-task acceptance run ACCEPTED.

## Open items (see cutlist)
F39 (alert or recover a delivery whose watermark jobs died), F41 (calibration, agent attacks, a human-attack
work queue), F32 (production node and external review: every re-check here is `development` evidence).
