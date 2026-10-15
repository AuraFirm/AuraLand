# Stage 8 plan (draft): Tier-2 environments and agent evals

Status: **draft for your review. No Stage 8 code starts until you approve it** ("defaults" accepts every default below).
Kit: `docs/kit/12` Stage 8, `07` section 5 (Tier-2), `08` (hostile agents, egress), `10` (escape suites), `05` (task kinds `repo_env`,
`agent_env`, orders of kind `environment`), `15` (build versus managed sandbox).

## 1. Where this starts
Stages 3 to 7 are built. Reusable: the Go judge agent and its protocol (leases, fencing, spool and retry), the Tier-1 isolate driver
and its escape suites, bundles (deterministic tars, content-addressed), task versions and validation (Stage 4), integrity flags
(Stage 6), the egress client (SSRF-safe), the `Signer`-style pattern of a port with a development adapter, the simulation harness.
Task kinds `repo_env` and `agent_env` exist in the schema and nothing runs them.

## 2. Honest limits of this stage (read this first)
- **There is no KVM anywhere I can reach.** This machine is an arm64 Mac; the Colima VM has no `/dev/kvm` (checked). A Firecracker
  microVM cannot be started here, so **I cannot observe a single microVM run, an escape-suite result, a start time or a density
  figure for Firecracker.** The project's rule is no sandbox claim without observation, and unrun custody code is a claim. So:
  **I do not write the Firecracker driver in this stage.** It waits for a KVM host (F32's production-node work, or a rented bare-metal
  or nested-virtualization instance) and gets its own slice, escape suite and review then (F68).
- **What I can really run: gVisor (`runsc`)**, the fallback the kit names (kit 07 section 5.2), on the arm64 Colima VM (it needs no
  KVM). Results are tagged `isolation=gvisor` and are **ineligible for credentials above assurance level 1 and for customer-delivered
  scores unless the customer opts in** (the kit's rule), enforced in code. Everything in this stage is therefore a lower-assurance
  Tier-2: real containment I can observe, not the microVM the kit wants for customers.
- The build-versus-managed-sandbox ADR and "cost per 1,000 runs" need a real node and prices. I record **what I measured on one
  development VM** (cold and warm start, runs per second, memory per run under gVisor) and say plainly it is not a cost model.
- No GPU workloads, no multi-VM topologies (kit). **No real agent or model is called:** the "reference agent" is a scripted program;
  customer model endpoints are a port with a fake (no provider account, F41).
- The sandbox pentest and the compromised-guest incident drill are things a human does; I write the drill script and the
  checklist, and run the drill against gVisor.

## 3. Decisions I need from you (my default in bold)
1. **Scope order.** **Environment spec and bundle format first (pure, testable), then the runtime port and a gVisor driver in the Go
   agent with its escape suite, then the in-guest init and protocol, then verifier isolation and reward-hack detectors, then
   record/replay, then the control-plane job kind, then the agent-runner interface and leaderboard, then docs and the report.**
   Firecracker, snapshots/restore and a real density spike wait for KVM.
2. **Isolation tag.** **Every Tier-2 result records `isolation` (`gvisor` now, `firecracker` later) and the control plane refuses
   to use a `gvisor` result for a credential above level 1 or a customer-delivered score unless the order says the customer opted in.**
3. **Environment spec.** **One recipe per environment: a base image digest (OCI image built reproducibly, pinned by digest), setup
   commands, the agent's command and workspace, resource limits, network policy (default none; allowlist of host:port), time
   limits, and a verifier that runs separately.** Spec `spec_version` 2 beside the existing algorithmic spec.
4. **Verifier isolation.** **The verifier and hidden material run in a second sandbox that receives only the final workspace
   snapshot (the kit's preferred form), never mounted into the agent's sandbox.** Hidden files are never in the agent's image.
5. **Reward-hack detection.** **Tamper detection (hashes of protected paths before and after), honeypot files, canary values
   randomized per run inside the hidden checks, and recorded attempts to reach the verifier or the network. A detection is an
   `integrity flag` on the run with an explanation (evidence for a person, never an automatic verdict), and lowers the task's
   un-gameability score.** A purpose-built reward-hack environment must be detected (acceptance).
6. **Network.** **Default none. An allowlist is resolved and pinned at start; implemented as a network namespace with default-drop
   rules, every flow logged (5-tuple and bytes). If I cannot make the allowlist observably contain a hostile run on this VM, the
   stage ships with network always off and says so.**
7. **Record and replay.** **Every command, workspace-tree-hash timeline and network flow is appended to a size-capped trace stored
   with the run and signed by the node; "deterministic replay" is claimed only for environments whose trace I replay and compare
   in a test.**
8. **Agent runner and leaderboard.** **The agent runner is an interface (a program in the sandbox, or a customer endpoint through
   the egress client with a short-lived credential); only a scripted reference agent runs here. Leaderboard-as-a-service reuses
   the contest scoreboard fold over environment runs; it is private to the customer by default.** Centaur and agent contest formats
   are out of this stage's build list unless you want them (they need Stage 5 format work).
9. **Red-team audit workflow.** **A checklist and a recorded-findings table (extending Stage 4's human-attack queue), not a tool.**
10. **Cost and density.** **Measured on one VM and reported as such; the build-versus-managed ADR is written with those numbers
    and the missing ones marked unknown.**

## 4. Work breakdown (one pull request each, tests first; report after each part)
**8A: the environment and a real Tier-2 sandbox (gVisor)**
| # | Slice | Verify |
|---|---|---|
| 0 | ADR 0034, environment spec v2 and limits (contracts), threat model section | contract tests |
| 1 | Install and probe `runsc` on the Colima VM; a Go `sandbox` driver for it (run, limits, teardown); the isolation tag | Go tests on the VM; **observed** start times |
| 2 | Tier-2 escape suite (filesystem, network, process, resource, kernel-surface probes), positive controls | suite passes on the VM, controls prove the probes can succeed |
| 3 | In-guest init and the control protocol (start, stream logs, limits, collect workspace) | protocol tests; golden run |

**8B: verification and evidence**
| # | Slice | Verify |
|---|---|---|
| 4 | Verifier in a second sandbox on the final workspace snapshot; hidden material never in the agent's image | test: the agent cannot read the verifier or hidden files |
| 5 | Reward-hack detectors and canaries; a purpose-built hacking environment | **the hacking environment is flagged; an honest run is not** |
| 6 | Network policy (default none; allowlist) with flow logging, if observably contained | containment tests; otherwise documented as off |
| 7 | Record and replay trace | replay equals the original for the deterministic sample |

**8C: control plane and product**
| # | Slice | Verify |
|---|---|---|
| 8 | Job kind `env.run`, run records, isolation-based eligibility rule, integrity flags on runs | db and HTTP tests, simulation of the run protocol |
| 9 | Agent runner interface, scripted reference agent solving a sample environment end to end, private leaderboard | end-to-end run on the VM |
| 10 | Measurements, ADR on build versus managed, compromised-guest drill, red-team checklist, runbook, ASVS and threat model, report | the harness's numbers, reported as one VM |

## 5. Security notes
Agent code is hostile by definition: it runs only on judge nodes, in a sandbox, with no network by default, no host paths and no
credentials, and a second sandbox holds the verifier. A result produced under gVisor can never be passed off as microVM-grade:
the tag is in the run record and the eligibility rule is enforced in the control plane. Traces are evidence and may contain
whatever the agent printed; they are size-capped and treated as untrusted text when shown. The node signs traces; the control plane
validates shapes and bounds as it does for Tier-1.

## 6. What this still will not do
Firecracker (F68), snapshot/restore sub-second starts, density and cost claims, production-grade assurance for customers, GPU, real
model providers, or any claim from a gVisor run that a microVM run would earn. It also will not ship a sandbox review: the external
pentest is a human task.

## 7. Things only you can provide
A KVM-capable Linux host (bare metal or nested virtualization; the production judge node of F32 would do) so Firecracker can be built
and observed; a sandbox reviewer/pentester; a customer who wants environments or evals, to say which environment first; a model
provider account and budget for real agent runs (F41); and a decision on whether to buy a managed sandbox for the first customers
while the Firecracker path is built.
