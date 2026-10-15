# Stage 8 report: Tier-2 environments and agent evals

Status: built, awaiting your review. Plan: [stage-8-plan.md](stage-8-plan.md). Decisions: `docs/adr/0034-stage-8-decisions.md` (with
amendments for every deviation) and `docs/adr/0035-build-versus-managed-sandbox.md` (proposed, yours to decide). Runbook:
[../runbooks/environments.md](../runbooks/environments.md). Red team: [../security/red-team-tier2.md](../security/red-team-tier2.md).
**Everything ran on gVisor on one arm64 development VM with no KVM. No Firecracker microVM was started, no production node exists,
no real agent or model was called, and nothing here has had an external sandbox review. A gVisor result is level-1-only by rule.**

## What exists
| Slice | What | PR |
|---|---|---|
| 0, 1 | ADR 0034, environment spec v2 and limits, isolation tag and rule; `runsc` driver (run, limits, teardown) | #124 |
| 2 | Escape suite (15 probes) with positive controls; it found the disk-fill gap | #125 |
| 3 to 5 | Sessions (setup steps then agent), workspace hashes, verifier in a second sandbox, reward-hack evidence | #126 |
| 6 | **Not built**: network is off for every run (F69) | n/a |
| 7 | Signed traces and replay | #127 |
| 8 | `env` job queue, run records, `eligible` generated column, trace verification, dead-run handling | #128 |
| 9 | Private leaderboard; the node leases and runs environments end to end | #129 |
| 10 | Measurements, ADR 0035, compromised-guest drill, red-team checklist, runbook, ASVS rows, threat model v11, this report | this PR |

## Verified (with evidence)
- **End to end on a Tier-2 node** (`node apps/api/src/env-e2e-cli.ts`, which starts a temporary database and API and enrols a node
  on the VM): an honest agent scores 1 with no flags; one that edits the check scores 0 with `protected_path_changed`; one that
  reads the honeypot scores 0 with `honeypot_touched`. All `isolation=gvisor`, `eligible=true`, signed traces accepted.
- **The isolation rule**: gVisor is eligible only up to level 1, never for customer delivery without opt-in, and opting in never
  raises the level (contract tests, a generated database column, HTTP tests).
- **Escape suite**: 15 probes contained, and the same 15 escape when unconfined (so a pass means contained).
- **Reward hacks**: a symlink to the hidden answer scored 1 before the fix and is now dropped and flagged; our own hashing no longer
  looks like the agent reading the honeypot.
- **Replay**: a deterministic sample replays equal; a step reading `/dev/urandom` is reported as different.
- **Drill**: after two hostile workloads (TLE, MLE, process limit), twice each, nothing of the run was left, the host canary was
  untouched and the next run was healthy.
- **Measurements, one VM, trivial program**: first run 57 ms; p50 42 ms, p95 54 ms; up to 49 runs per second at 4 workers on 4
  CPUs; a sleeping sandbox 15 MiB in its cgroup (workspace bytes are charged to the node, not the cgroup).
- Gates: `pnpm check` clean; `pnpm test` 1,811 tests; `pnpm test:sim` 500/500 seeds on every scenario; `go test ./...`; the
  `-tags gvisor` Tier-2 suite on the VM.

## Mistakes and fixes worth knowing
- The first end-to-end run produced nothing and the agent log said only "serving": the failures were in the job rows. Real images
  contain hard links (my unpacker refused them) and an unprivileged node cannot chown host files. Both fixed with tests; the
  e2e command now prints node state and job errors when a run does not finish.
- My first drill assumed a fork bomb ends with a limit verdict; it can starve its own script and exit normally. The drill now
  asserts "a limit stopped something" and uses a second, long-lived workload for TLE and MLE.
- The drill's first version blamed a run for a stale sandbox from an earlier session (found alive after 90 minutes). It now compares
  host state before and after. The stale sandbox itself is a real finding (F71).
- CI: registry rate limits failed `images` twice; re-runs passed.

## Not verified, not built
- **Firecracker** (F68), **snapshot/restore**, density and cost (F75). **Network allowlist** (F69). **Unpacker inside a sandbox**
  (F70). **Startup sweep and a reaping supervisor** (F71). **Customer model endpoints** (F72). **External review** (F73).
  **Memory admission control** (F74). **Centaur and agent contests** (F76).
- Measurements are for `true`, not for a real environment; no figure here is a capacity or cost claim.
- ASVS rows: 4 Met, 9 Partial, none Not met (`docs/security/asvs-matrix-stage-8.md`).

## Decisions I made that you may overrule
1. No in-guest init and no vsock: each step is its own sandbox (ADR 0034 amendment).
2. Slice 6 not built: network off, allowlist refused by the node.
3. The workspace is a memory file system of exactly the disk limit (costs host memory).
4. The leaderboard is private to the customer and reuses the scoreboard fold.
5. Build-versus-managed is left to you (ADR 0035 recommends: keep gVisor as the floor, wait for KVM for Firecracker, consider a
   managed provider for the first customer who needs microVM grade).

## Next
You: `docs/owner-tasks.md` section 3.10 (a KVM host, the build-or-buy decision, a reviewer, a customer). Engineering when
unblocked: F68 to F76, then Stage 9 per `docs/kit/12`.
