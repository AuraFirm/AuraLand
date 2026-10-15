# 0034 — Stage 8 decisions (Tier-2 environments and agent evals)
Status: accepted
Date: 2026-10-15

## Context
The owner accepted the defaults of `docs/stages/stage-8-plan.md`. Environments let an agent (or a person's program) work in a
shell-like place and be scored by something it cannot touch. Two facts shape everything: the code that runs is hostile by
definition, and **no KVM is reachable from the development machine**, so a Firecracker microVM cannot be started or observed here.

## Decisions
1. **No Firecracker driver in this stage.** The project rule is no sandbox claim without observation. A driver written without ever
   running it is a claim. Firecracker, snapshot/restore, density and cost-per-run wait for a KVM host (cutlist F68).
2. **gVisor (`runsc`) is the Tier-2 runtime here**, the fallback the kit names (07 section 5.2), run on the arm64 Colima VM.
   Every run records `isolation` (`gvisor` or `firecracker`). `isolationAllows` (contracts) is the one place the rule lives: a gVisor
   result may not support a credential above assurance level 1, nor be delivered to a customer as their score unless they opted in,
   and opting in never raises the level. The control plane enforces it where results are used (slice 8).
3. **Environment spec v2** (`envSpecSchema`): an image pinned by `sha256:` digest, setup argvs, the agent's argv, workspace and
   limits, a network policy (`none`, or an allowlist of DNS names and ports: no address literals, no private names), a verifier
   (argv, limits, per-run canary count), integrity paths (protected, honeypots) and scoring. Commands are argvs, not shell strings.
4. **Verifier isolation.** The verifier and hidden material run in a second sandbox that receives only the final workspace
   snapshot. Hidden files are never in the agent's image or mounts.
5. **Reward-hack detection** produces integrity flags on the run (evidence with an explanation, for a person to decide), never an
   automatic verdict; tamper hashes, honeypots, per-run canaries and recorded attempts to reach the verifier or the network.
6. **Network default none.** An allowlist ships only if it is observed to contain a hostile run on the development VM; otherwise the
   stage ships with the network always off and says so.
7. **Record and replay.** A size-capped, node-signed trace of commands, workspace-hash timeline and network flows. Replay is
   claimed only for environments whose replay is compared with the original in a test.
8. **Agent runner and leaderboard.** Only a scripted reference agent runs here; customer model endpoints are a port with a fake.
   The leaderboard folds environment runs like the contest scoreboard and is private to the customer by default.
9. **Measurements** (start times, runs per second, memory per run) are taken on one development VM and reported as such.
   The build-versus-managed-sandbox ADR records them and marks what is unknown.

## Consequences
New tables and a job kind (slice 8) carry RLS and rows in the RLS matrix and ADR 0003. The Go agent gains a second sandbox driver
behind the existing sandbox interface. Task kinds `repo_env` and `agent_env` stay unsupported in `TASK_KINDS_SUPPORTED` until
slice 8 turns them on together with their validation.

## Amendments
- **Slice 3: no in-guest init and no vsock.** The kit's `aura-init` and vsock channel exist because a microVM has to be
  driven from outside. With gVisor each step (a setup command, then the agent) is its own sandbox over the same workspace,
  about 35 ms apiece, so the host needs no channel into anything running inside and every step gets a clean process table and
  the same containment. A `Session` runs the steps under one shared wall budget, stops at the first failed setup command, and
  hashes the workspace after every step (`HashTree`: paths, kinds, permission bits and contents, never following links), which
  is what the trace (slice 7) and the tamper check (slice 5) are built on. When a Firecracker driver exists it may bring an
  in-guest init back; the `Runtime` interface does not change.
- **Slice 2: the workspace is a memory file system of exactly the disk limit**, copied in and out without following links,
  because the escape suite showed a per-file limit does not bound the total. The agent's disk therefore counts against host
  memory.
- **Slice 6: the network stays off.** An allowlist needs a per-run network namespace with a veth pair, default-drop rules,
  pinned name resolution and flow logging, and proof that a hostile run cannot get past it. That is a project of its own and I
  did not make it contained on this VM, so the node refuses any environment whose `network.mode` is `allowlist` (slice 8) and
  every run has no network. The spec still carries the allowlist so recipes written now keep working when it exists (cutlist F69).
- **Slice 7: traces.** A trace holds hashes of what was printed, never the text; its canonical bytes are signed by the node with a
  domain (`AURA-TRACE-V1`) no request signature uses. `Replay` re-runs a session from a pristine copy and compares every step; an
  environment is called deterministic only when its replay reports equal (a test shows a random one is caught).
