# Stage 4B plan (draft): validation, so that "not performed" becomes a result

Status: **draft for your review. No 4B code starts until you approve it.** Kit: `docs/kit/12` Stage 4
(adversarial validation harness v1, `ungameability_score`, immutable validation report), `docs/kit/07`.

## 1. Where this starts
4A delivers packs labeled `validation: not performed`. 4B replaces that with measured results. Its
prerequisite, a sandbox that works, now exists in a limited form: on 2026-10-12 the escape suite ran
for the first time (Colima Ubuntu 24.04 VM, isolate 2.1.1) and passed after three driver fixes
(`judge/node/README.md`). That is a **development** result. The production-spec node and the external
review (F32) are still outstanding, so 4B is built and tested on the VM node, and **no report may be
shown to a customer as validated until a production node, reviewed, has produced it** (decision 1).

## 2. Decisions I need from you (my default in bold; "defaults" accepts all)
1. **Attestation.** **A node declares `development` or `production` (set by its operator at
   enrollment); every validation report records which kind produced each run; the portal and manifest
   say "validated (development sandbox)" or "validated" accordingly, and only `production` reports ever
   reach the second form.** Alternative: wait for F32 before writing any code.
2. **Bundle convention for solutions.** The format allows free-form `solutions/*`. **New rule:
   `solutions/reference.<ext>` is required for validation and must pass every test; `solutions/wrong_<name>.<ext>`
   (any number, at most 20) must fail at least one test.** Extensions map to the C++ and Python profiles.
3. **Validator program.** ADR 0027 chose to run the existing TypeScript bundle validator inside a box
   under a pinned Node. **Keep that** (no Go port): the agent mounts a pinned Node runtime read-only.
4. **Models.** **Build the `LlmProvider` port, a recorded-replay adapter and a fake; no real provider
   until you create an account.** Difficulty calibration and model attackers run on replay data in tests;
   real calibration needs your provider key (owner task).
5. **Attackers.** **Built-in deterministic attackers first** (print sample answers, constant outputs,
   read-and-echo, brute force that times out, wrong-complexity solutions from the bundle's
   `wrong_*` files); model attackers come through the port. A human-attack queue is a table and a
   screen, built last.
6. **Score.** **`ungameability_score` (0 to 100) = 40 × mutation kill rate + 30 × share of built-in
   attackers rejected + 20 × consistency checks passed + 10 × test coverage of declared groups; a task
   with any consistency failure, or a score under 70, cannot become `validated`.** The formula is
   written in the methodology page and versioned (`score_version`). You may change the weights.
7. **Test-data watermarks** (per-delivery perturbations with an equal-verdict proof) are **deferred to
   4C**, after validation works; rewriting bundles is its own security review.
8. **Release.** Release stays possible by waiver for now; **after 4B a non-waived release needs a
   `validated` version**, and waived ones are re-validated automatically (F30).

## 3. Assumptions
Same stack and rules as before; new dependencies: none planned. Validation jobs go to the `judge` queue
with a new kind `task.validate`; the control plane computes every score from per-run observations the
node reports (a node's own claims, like a verdict, are never trusted: same rule as submissions).
Untrusted code runs only in boxes on judge nodes. New tables follow the pattern (RLS, matrix rows).

## 4. Work breakdown (one pull request each, tests first)
| # | Slice | Verify |
|---|---|---|
| 0 | ADR 0029, contracts (report, run observations, score), bundle rule for `solutions/` in the validator and corpus | validator corpus, contract tests |
| 1 | Agent bundle opener (F31): download by hash, check SHA-256, unpack inside a box with the pinned-Node validator, return the file list | Go tests, VM run with real isolate |
| 2 | `task.validate` job and `validation_reports` (immutable): consistency checks (reference passes, wrong ones fail, validator accepts inputs, deterministic twice) | simulation of node results, HTTP tests, VM run |
| 3 | Mutation testing: C++ and Python mutant generator (pure), runs in boxes, kill rate | property tests, VM run |
| 4 | Built-in attackers and their scoring | unit tests, VM run |
| 5 | `ungameability_score` (pure), state change `validating → validated`, release gate | rules tests, state-machine simulation extended |
| 6 | `LlmProvider` port, replay adapter, difficulty calibration | port contract tests, replay |
| 7 | Human-attack queue (table, routes, screen) | RLS tests, browser test |
| 8 | Portal and manifest show the report and its attestation; methodology page; threat model v5; ASVS rows; report | gate checklist |

Acceptance (from the kit): a deliberately weak task (tests that accept a hard-coded answer) is rejected
by the harness; a strong one scores above the threshold; the report is immutable and tamper-evident.

## 5. Security design (key rules)
Node results are observations, scores are computed by the control plane; a report row never changes;
a node cannot name another job's bundle; attackers and mutants are untrusted code like any submission
(same sandbox, same limits); a `development` node can never produce a `production` report; model output
is never the sole authority (kit): it informs calibration, not the pass/fail of consistency checks.

## 6. Invariants
1. A `validated` version has a report whose consistency checks all passed.
2. A report is never updated or deleted.
3. A report names the attestation of every node that contributed.
4. No customer-facing "validated" without a `production` attestation.

## 7. Things only you can provide
A model provider account and key (slice 6, real calibration); the production judge node and external
review (F32), without which no report reaches the second form of "validated"; your call on the score
weights.
