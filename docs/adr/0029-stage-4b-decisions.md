# 0029 — Stage 4B decisions (validation)
Status: accepted
Date: 2026-10-12

## Context
The owner approved `docs/stages/stage-4b-plan.md` ("then proceed" after the plan listed its defaults).
The sandbox ran its escape suite once on a development VM (cutlist F32 stays open).

## Decision
1. Nodes declare `development` or `production`; every validation report records the attestation of each
   node that contributed. Only a `production` report may be shown to a customer as plain "validated".
2. `solutions/` is no longer free-form: `reference.<cpp|py>` (at most one) and `wrong_<name>.<cpp|py>`
   (at most 20). Validation reads the role from the name, so it never has to guess. The format keeps the
   reference optional; validation refuses a task without one. This applies to bundles uploaded from now
   on; already-published bundles are not re-checked.
3. The TypeScript bundle validator keeps running inside a box under a pinned Node (no Go port).
4. `LlmProvider` port with a replay adapter and a fake; no real provider until an account exists.
5. Built-in deterministic attackers first; the human-attack queue last.
6. `ungameability_score` = 40 x mutation kill rate + 30 x attackers rejected + 20 x consistency +
   10 x coverage, threshold 70, versioned by `score_version`; any consistency failure blocks `validated`.
7. Test-data watermarks are deferred to 4C.
8. After 4B a non-waived release needs a `validated` version.

## Alternatives considered
Free-form solutions with a manifest listing roles (a second source of truth that could disagree with
the files); a Go port of the validator (two implementations to keep equal); waiting for F32 (nothing
could then be tested on real isolate).
