# 0035 — Build or buy the Tier-2 sandbox (gVisor now, Firecracker later, or a managed service)
Status: proposed (a decision for the owner; the engineering recommendation is below)
Date: 2026-10-15   Deciders: owner (human-owned decision, kit 15 section 3)

## Context
Tier-2 runs hostile agent code. Stage 8 built the whole path on gVisor (`runsc`, systrap) because the only machine available, an
arm64 Mac with a Colima VM, has no `/dev/kvm`, so no Firecracker microVM could be started or observed (ADR 0034, F68). Kit 07
section 5 wants microVMs for customer-delivered scores and for credentials above level 1; the code enforces that
(`isolationAllows`, generated column `env_runs.eligible`): **a gVisor run can never reach those uses unless the customer opts in, and
opting in never raises the assurance level.**

The question the kit asks: do we keep building the sandbox ourselves, or buy a managed one for the first customers?

## What was measured (one development VM, 4 CPUs, 5.9 GiB, Ubuntu 24.04 aarch64 under Colima; gVisor systrap)
These are numbers for a trivial program (`true`), taken by `TestMeasure*` in `judge/internal/tier2/measure_gvisor_test.go`
(run with `-tags gvisor`). They are **not** a cost model, a capacity claim or a Firecracker figure.

| Measure | Result |
|---|---|
| First run (cold), end to end (workspace in, sandbox, workspace out, teardown) | 57 ms |
| Sequential, 20 runs | p50 42 ms, p95 54 ms, max 65 ms |
| Throughput, 40 runs, 1 / 2 / 4 / 8 workers | 23.4 / 39.2 / 49.3 / 47.0 runs per second (4 CPUs: saturates at 4) |
| A sandbox that only sleeps | 15 MiB peak in its cgroup |
| A sandbox holding 64 MiB in its workspace | 32 MiB peak in its cgroup; **the workspace is a memory file system made by the node, so its bytes are charged to the node and not to the sandbox's cgroup** |

So host memory per run is about the cgroup peak (15 MiB idle) plus the workspace limit (`disk_limit_mib`, up to the limit if the agent
fills it). A real environment run is dominated by other things these figures do not include: downloading and unpacking the image
(a 4 MB busybox image in the end-to-end test), the agent's own work, and the verifier's second sandbox.

## Unknown (do not quote anything from this ADR as if these were known)
- Firecracker cold start, snapshot-restore start and density: nothing observed (F68).
- Prices of any managed sandbox, and its start time, density, regions, data residency, logging and its own escape record.
- Cost per 1,000 runs for either path: needs a priced node and a real workload.
- How gVisor behaves on the kernel and CPU of a production node (only one VM kernel was tried).
- Whether the cloud we choose offers KVM (bare metal, or nested virtualization) at a price we accept.
- A real agent's run time: the only agent run was a script.

## Decision (recommended)
1. **Keep the `Runtime` port and the gVisor driver as the Tier-2 floor.** It works, is observed, and is honest about being the
   lower assurance. Use it for development, for authors validating environments, and for customers who opt in knowing what it is.
2. **Do not write the Firecracker driver until a KVM host exists** (F68), then do it as its own slice with its own escape suite.
   Everything above the port (spec, session, snapshot, verifier, traces, eligibility, job queue) does not change.
3. **For the first customer who needs microVM-grade assurance before our own driver exists, buy a managed microVM sandbox behind
   the `Runtime` port**, after the owner has checked: its isolation technology, who can see the code and traces, regions and
   residency, price per run, and its security record. The port is small (run one environment, return a result with an `isolation`
   tag), so this is an adapter and an eligibility entry, not a rewrite.
4. **Never mark a managed result `firecracker` or `gvisor` by assumption.** The tag must be what the provider attests; an unknown
   provider gets a new tag that `isolationAllows` treats as level 1 until reviewed.

## Alternatives considered
- **Build only (Firecracker ourselves).** Best control and unit cost at scale; slowest to first customer, needs KVM hosts, a
  kernel and rootfs pipeline, a jailer, snapshots and a sandbox reviewer. Cannot start until a KVM host exists.
- **Buy only.** Fastest to a microVM-grade claim. Costs money per run, puts hostile code and customers' hidden material on someone
  else's machines (a data-processing agreement and a review), and ties start time and density to a vendor. Not measured here.
- **gVisor only, forever.** Simple and observed, but it shares the host kernel and the kit does not accept it for customer-delivered
  scores.
- **Docker/runc containers.** Rejected: a plain container is not a boundary for hostile code.

## Consequences
Customers get the Tier-2 product on a lower-assurance floor now, clearly labeled in every result. Credentials above level 1 and
customer-delivered scores from Tier-2 stay blocked until Firecracker or a reviewed managed provider exists. Operations must treat
the workspace memory file system as node memory when deciding how many runs a node may hold at once (F74).

## Verification
Measurements above (reproducible with the command in the test file). Eligibility rule: contract tests, `env_runs.eligible` database
tests and HTTP tests (slice 8). Drill: `TestCompromisedGuestDrill...` (slice 10).

## Revisit trigger
A KVM host is available (build Firecracker and re-measure); or a customer asks for credentials above level 1 or customer-delivered
Tier-2 scores before it is (evaluate a managed provider); or measured cost per 1,000 runs on a real node exceeds what a customer
pays for them.
