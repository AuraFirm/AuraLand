# Stage 4B report: validation (core)

Status: **core built, ready for your review.** Plan: [stage-4b-plan.md](stage-4b-plan.md) (you said
"proceed", which I took as accepting its defaults). Decisions: [ADR 0029](../adr/0029-stage-4b-decisions.md).
**Not built:** model calibration (slice 6, needs a provider account) and the human-attack queue (slice 7).
Everything that ran a sandbox ran on **one development VM**, so every report today is a `development` report.

## Read this first: what is verified and what is not
| Claim | State |
|---|---|
| A reviewer can ask for validation; the version moves to `validating` and a job is queued in one step; the application role cannot start or finish validation by a bare update | **Verified** (`validation.test.ts` db, `http-validation.test.ts`) |
| A judge node opens a bundle without parsing an archive itself (validator in a box, strict flat stream) | **Verified in a real sandbox** on the VM: good bundle opens; 300 MiB zip bomb, symlink, missing statement, bad solution name are refused with the validator's codes |
| A node runs the reference twice and every wrong solution on every test, up to 40 mutants of the reference, and 10 trivial attackers, and reports only what it saw | **Verified in a real sandbox** (`validate_isolate_test.go`): reference AC twice, off-by-one WA, loop TLE, non-compiling and Python wrong solutions as expected; the sum program's only mutant is killed |
| The control plane draws every conclusion (checks, score) and rejects reports that cannot be true | **Verified** (`rules.test.ts`, `score.test.ts`, HTTP tests) |
| Reports are immutable; a version is validated only with a passing report; a node's attestation is read from its own row | **Verified** (database tests) |
| A task with only public tests is flagged (lookup attacker); a task a generic program solves (sum of two numbers) is flagged | **Verified in a real sandbox**, and note the second one: the sample task of the test corpus is rejected by the harness |
| Deliveries state validation honestly: plain "validated" only for a production report | **Verified** (`rules.test.ts` orders, `handlers.database.test.ts`) |
| The portal shows the request button, the report and the release button for validated versions | **Built and type-checked, the web build passes, NOT exercised in a browser** (no new Playwright test) |
| **Any task is validated in the sense a customer should rely on** | **No.** No production node exists and there has been no external review (F32); no model or human has attacked a task; difficulty is not measured |
| The real agent leasing a real job from a running API, end to end | **No.** Each half is tested (HTTP tests with signed fake nodes; real sandbox with a stubbed fetch); the two were never joined in one run |
| Deployed anywhere | **No** (F1) |

## What was built (pull requests #59 to #67)
Plan (#59); `solutions/` naming rule and ADR (#60); bundle opener in a box (#61); `aura-judge run` (#62);
node attestation, `validation_reports`, `request_validation`/`settle_validation` (#63); the validate
job end to end (#64); mutation testing (#65); built-in attackers (#66); the score and threshold (#67);
reports made visible (manifest, portal, methodology, threat model v5, runbook; the next pull request).

## Decisions I made that you may overrule
1. Validation needs at least one wrong solution; a task with none fails `wrong_solutions_present`.
2. An attacker "beats" a task only if it passes **every** test; then that task cannot be validated.
3. No compiling mutant counts as 0 for the mutation share, not as full marks.
4. Coverage is "share of test groups with at least two tests".
5. A node refuses custom-checker and interactive tasks (not validated yet).
6. Mutants are textual swaps; equivalent mutants are not detected, so the kill rate is a lower bound.
7. The `validate` queue is separate from `judge`; at most 100 ready jobs.
8. A development node's report says "validated on a development sandbox only" in deliveries and the portal.

## Found and fixed on the way
- Releasing a validated version always answered "needs approval" (approval was only looked up for
  versions in review). Latent since Stage 2 because nothing reached `validated`.
- `select ... for update` needs UPDATE rights the worker role deliberately lacks, so the validation
  read is unlocked and `settle_validation` takes the lock.
- The stack-bomb lesson again: my own test corpus bundle was "too easy" and the attackers said so.

## Evidence at the end of the stage
`pnpm check` clean; `pnpm test` 1,248 tests in 94 files (up from 1,198 in 89); `pnpm test:sim` five
scenarios 500/500; web build passes; Go tests green; `go test -tags isolate` for `internal/bundles` and
`internal/validate` passes on the Colima VM (Ubuntu 24.04, aarch64, isolate 2.1.1, Node 24.21.0).
No browser tests were added; the earlier 24 were not re-run for this stage.

## Open items (see cutlist)
F30 (waived releases not re-validated automatically; custom checkers), F31 (the joined end-to-end run),
F32 (production node and external review: blocks any plain "validated"), F41 (calibration, human
attacks, test-data watermarks), F43 (no admin screens).
