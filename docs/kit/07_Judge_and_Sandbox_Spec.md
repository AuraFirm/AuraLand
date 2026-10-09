# 07 — Judge and Sandbox Specification

> This is the most security-critical component. A sandbox escape is the existential technical risk (New_Plan/05 §5). Everything here is **defence in depth**: assume any single layer will fail.

## 1. Threat model for execution
Attackers: (a) contestants/students submitting hostile code; (b) AI agents under test trying to reward-hack, read hidden tests, or escape; (c) a malicious task author/customer environment; (d) a compromised judge node attempting lateral movement; (e) side channels (timing, resource exhaustion).
Goals to prevent: host compromise, cross-submission leakage, hidden-test/verifier exfiltration, result forgery, denial of service, persistent footholds, network abuse (scanning, mining, exfil).

## 2. Architecture

```
Control plane (api/worker) ──(job in Postgres)──▶ lease via mTLS HTTPS (outbound from node)
                                                   │
                         ┌─────────────────────────▼─────────────────────────┐
                         │ aura-judge (Go, runs as unprivileged user + caps)  │
                         │  protocol client · bundle cache · SQLite spool     │
                         │  scheduler (cores, memory) · self-test · canary    │
                         └───────┬───────────────────────────────┬────────────┘
                     Tier-1      │                               │     Tier-2
              ┌──────────────────▼───────────┐       ┌────────────▼──────────────────┐
              │ isolate box (per run)        │       │ Firecracker microVM (per run) │
              │ ns+cgroup v2+seccomp+rlimit  │       │ jailer+KVM, own kernel, vsock │
              │ no network, tmpfs, RO rootfs │       │ egress allowlist, snapshots    │
              └──────────────────────────────┘       └────────────────────────────────┘
```

## 3. Judge node baseline (applies to every node)
- Dedicated bare-metal host with KVM; **no other workloads**; minimal OS (current Ubuntu LTS server minimal or Flatcar), automatic security updates with reboot windows, kernel hardening (`kernel.unprivileged_userns_clone` policy decided by test, `kernel.kptr_restrict=2`, `kernel.dmesg_restrict=1`, `kernel.yama.ptrace_scope=2`, `net.ipv4.conf.*.rp_filter`, `vm.unprivileged_userfaultfd=0`).
- cgroup v2 only. Hyper-threading **siblings of the judged core are kept idle or the box runs with SMT off** for timing determinism and side-channel reduction. CPU frequency governor `performance`, turbo off for timing-critical pools. Judged processes pinned to dedicated cores (`cpuset`), memory node-local.
- Agent runs as a non-root service user; privileged operations (isolate init, cgroup delegation) go through the minimal `isolate` setuid helper or systemd delegation. Agent has **no cloud credentials**; its only identities are its node keypair (mTLS client cert, short-lived, renewed via the enroll key) and per-job presigned URLs.
- Host firewall: **deny all inbound** except SSH from a bastion/WireGuard (or none: use SSM-like agent); outbound allowlist to control plane + S3 endpoints + package mirror (for image builds, not at judge time).
- Node attestation at boot: agent self-test (runs the **escape regression suite** + timing calibration); node enters `active` only if it passes (`canary_ok_at`). Re-run every 6 h and after each deploy; failure ⇒ node `draining`.
- Disk: separate partitions with `noexec,nosuid,nodev` where possible for work dirs; per-run work directories on tmpfs or an XFS project-quota directory with hard quota; wiped (and for microVMs, the whole VM discarded) after each run.
- Logs from the sandbox are **data**, never interpreted by privileged code; size capped; stripped of control characters before storage.

## 4. Tier-1: isolate-based judging

### 4.1 Pipeline per submission
1. **Fetch** bundle by sha256 from cache (verify hash on download; cache capped, LRU; refuses mismatch). Bundle unpacked once into a read-only per-bundle directory (zip-slip safe, size/entry-count/ratio limits, no symlinks/hardlinks/devices).
2. **Compile** (if needed) in its own isolate box: network off, 10 s wall limit by default (language-specific), 512 MiB memory, output cap 64 KiB; compiler errors truncated and sanitized.
3. **Run** each test in a fresh box (or reused box with full wipe for speed on big test sets, configurable per profile—**default fresh**): stdin from the test file, stdout/stderr to size-capped files.
4. **Check**: a separate box runs the checker (testlib-compatible) with the input, jury answer and contestant output mounted **read-only**; the checker is trusted code from the bundle but still sandboxed; hidden tests and the jury answers are never visible in the contestant's box.
5. **Report**: per-test verdict, CPU/wall time, peak memory, exit/signal, truncated checker message → agent validates schema/bounds → writes to SQLite spool → `complete` to control plane → deletes from spool on `ack`.

### 4.2 Isolation controls (all must be on)
`isolate --cg` with: PID/mount/net/IPC/UTS namespaces (no network namespace connectivity), cgroup v2 memory limit + swap 0 + `pids.max` (default 64), CPU time limit (rlimit + cgroup), wall limit (≈ 3× CPU), stack limit, file-size limit (`fsize`), open-file limit, core dumps off, `no_new_privs`, capabilities dropped, a **seccomp-BPF allowlist** per language profile (default deny; allow minimal syscalls; kill on violation; log violating syscall number), read-only bind of the language runtime, tmpfs `/tmp` of fixed size, `/proc` restricted, no `/dev` beyond null/zero/urandom(only if required).
Run as unique uid per box (isolate allocates).

### 4.3 Resource & verdict semantics
| Verdict | Definition |
|---|---|
| `AC` | all tests passed (or score = max) |
| `WA` | checker says wrong |
| `TLE` | CPU time > limit (primary) or wall > wall limit |
| `MLE` | cgroup OOM or peak RSS > limit |
| `OLE` | output > cap |
| `RTE` | non-zero exit / signal / seccomp kill |
| `CE` | compile error / compile limits exceeded |
| `PARTIAL` | IOI-style subtasks, with `score` |
| `SE` | **system error** (node/IO/sandbox failure): never shown as a user fault; job is retried on another node up to `max_attempts`, then `failed_system` + alert |
- **Time measurement:** CPU time from cgroup `cpu.stat` (user+sys); report in ms; limits stated in ms with a documented tolerance; submissions within 10 % of the limit are **re-run up to 3×** and the median is taken (flaky-borderline policy, recorded as `borderline_rerun=true`).
- **Determinism targets:** same submission on the same pool varies < 3 % CPU time; the node canary tracks drift and removes a node from rotation if variance exceeds threshold.
- **Language profiles** (versioned in `judge/images`): C11, C++20, Java 21, Python 3.12 at launch; Rust, Go, JS/TS (Node), Kotlin, C#, SQL (SQLite/Postgres) in Stage 5+. Each profile pins compiler/runtime version, flags, seccomp allowlist, time multiplier. Profiles are immutable per version; contests record the profile version used.

### 4.4 Interactive and special tasks
Interactor problems run two boxes connected by pipes with strict byte caps; communication tasks and output-only tasks are supported by task kinds in the spec. Special judges use testlib API.

## 5. Tier-2: Firecracker microVMs

### 5.1 When used
Tasks that need processes, shells, package managers, files, local services, or controlled network (repo environments, agent tasks, SQL/DevOps/security scenarios).

### 5.2 Design
- Each run = **fresh microVM** from a base rootfs + per-task overlay (copy-on-write); torn down at the end; never reused across tenants or runs. Firecracker launched via **`jailer`** (chroot, new namespaces, seccomp, cgroups, unprivileged uid/gid).
- Guest kernel: minimal config we build and sign (no unnecessary drivers/modules); no virtio devices beyond block, vsock (and net if the task allows); guest has **no access to host paths**.
- Control channel: **vsock** to an in-guest `aura-init` (tiny static binary) that starts the task command, streams logs, enforces in-guest limits, and executes the verifier **out of the agent's reach**: verifier and hidden tests live on a **separate read-only block device attached only after the agent phase ends**, or are run in a second VM that receives only the final workspace snapshot (preferred for reward-hack resistance).
- **Snapshot/restore** of a warm base VM for sub-second starts; snapshots are per-tenant-per-base and carry no secrets or entropy (re-seed RNG, resync clock on restore).
- **Network:** default none. When needed: per-VM tap device into a network namespace with nftables default-drop, allowlisted destinations (resolved and pinned at VM start), DNS via a controlled resolver, rate and byte caps, no access to metadata IPs, RFC1918, link-local, or the host. All flows logged (5-tuple + bytes) as evidence.
- **Record/replay:** every command, file diff (workspace tree hash timeline), and network flow is recorded to an append-only trace (size-capped), signed by the agent and stored with the run for audit and instructor/customer replay.
- **Anti reward-hacking primitives:** read-only verifier mounts outside the agent namespace; tamper detection (hash of protected paths before/after); detection of attempts to read `/proc`, mount verifier devices, modify test runner config, monkey-patch test libs, network exfil; resource/time normalization; per-run randomization of canary values inside hidden tests; "honeypot" files that flag snooping. Violations are recorded as `integrity_flags` on the run, and the task's un-gameability score accounts for them.
- **Fallback:** where KVM is unavailable (dev, some clouds), the same agent can use **gVisor (runsc)** at lower assurance; results are tagged `isolation=gvisor` and are **ineligible for credentials ≥ L2 and for customer-delivered scores** unless the customer opts in.
- Decision gate (Stage 8 spike, from New_Plan/12): measure cold/warm start, density per host, cost per 1,000 runs, escape-suite results; compare against a managed sandbox provider; record in an ADR. Build on open-source runtimes; do not write a VMM.

## 6. Control-plane ⇄ node protocol rules
1. **Outbound-only** from the node. The control plane has no credentials to reach into nodes.
2. **Authentication:** mTLS with per-node client certs (≤ 24 h validity, renewed with the enrollment key); control plane maps cert → `judge_nodes` row and checks `state='active'` and queue authorization.
3. **Lease** (≤ 25 s long-poll) returns at most `k` jobs the node has capacity for. `lease_epoch` is the **fencing token** echoed on heartbeat/complete/fail.
4. **Result validation** at the control plane: schema, bounds (counts ≤ tests, times ≥ 0 and ≤ wall limit, memory ≤ node limit), consistency (verdict ↔ score), epoch, and plausibility. Violations ⇒ discard, flag node, alert.
5. **Spool-and-retry:** the agent writes results to SQLite before sending; resend on reconnect; control plane's `complete` is idempotent per `(job_id, lease_epoch)`.
6. **Poison jobs:** if a job crashes the same sandbox config twice on different nodes, mark `dead`, quarantine the submission hash, alert the security channel (possible exploit attempt).
7. **Drain:** `draining` stops new leases, finishes in-flight, then idles for deploy/maintenance. Rolling deploy never drains more than 25 % of a pool.
8. **Rejudge:** an admin/setter action enqueues new jobs with `reason`; old verdicts are kept as history; the "current" verdict pointer moves atomically; contest scoreboards recompute from the log.

## 7. Task bundle format (v1)

A bundle is a deterministic tar (sorted entries, zeroed mtimes/uids), compressed with zstd, content-addressed by SHA-256 of the **uncompressed tar**. Layout:

```
bundle/
├─ task.json                # TaskSpec (validated by contracts), includes spec_version
├─ statement/{en.md, bn.md, assets/*}     # sanitized on ingest
├─ tests/{001.in, 001.ans, ... }          # hidden by default
├─ samples/{1.in, 1.out}                  # public subset
├─ checker/{checker.cpp | checker.py}     # optional special judge (testlib compatible)
├─ solutions/{ref.cpp, wa1.py, tle1.cpp}  # reference + intentionally wrong solutions for validation
├─ generators/{gen.cpp, script.txt}       # test generators (provenance)
├─ validator/{validator.cpp}              # input validator (must pass for every test)
└─ env/                                   # Tier-2 only: Dockerfile-equivalent recipe → image digest, verifier/, hidden/
```

`TaskSpec` (abridged): `spec_version, kind, title, time_limit_ms, memory_limit_kib, output_limit_kib, languages[], scoring{type:'binary'|'subtasks'|'ratio', subtasks[]}, tests[{id, group, points, is_sample}], checker{type}, interactive?, env?{image_digest, network_policy, tools_allowed[], max_steps, max_wall_s, verifier{kind}}, difficulty{est, calibration_runs[]}, license{owner, terms}, provenance{author, reviewers[], created, generated_with_ai: bool}`.

**Ingest validation (bundle parser = fuzzed code):** reject if > size cap; entries > 5,000; path traversal/absolute/NUL; symlink/hardlink/special files; compression ratio > 100:1; any test file > 64 MiB; spec fails schema; any referenced file missing; hashes mismatch. The parser runs **inside a sandbox** on a judge node (never on the API host).

## 8. Adversarial validation harness (Forge's quality moat)
Pipeline job `task.validate` (runs on judge nodes, orchestrated by the worker):
1. **Consistency:** validator accepts all tests; reference passes; known-bad solutions fail the expected way; checker is deterministic.
2. **Mutation testing:** mutate reference solutions (operators: off-by-one, boundary, init, comparison flips) — each mutant must be killed by ≥ 1 test; report mutation score.
3. **Difficulty calibration:** run named frontier-model agents and baseline solvers (k attempts each) → pass-rate bands; store `calibration_runs` with model name/version/date.
4. **Attack:** (a) LLM attacker agents with the *same* sandbox + instructions to maximize score without solving (reward-hack search); (b) human hackers (queue for setters/reviewers); (c) static checks for leaked answers/known benchmark contamination (n-gram/embedding search over public corpora, behind a `ContaminationIndex` port).
5. **Score:** `ungameability_score ∈ [0,1]` = f(mutation score, attack success rate, flakiness, leak checks), with the formula versioned and published in the methodology doc. Release requires ≥ policy threshold (configurable, default 0.85) **or** explicit reviewer waiver recorded in audit.
6. **Report:** immutable `validation_report` stored; included in deliveries.

## 9. Escape-regression suite (`judge/testdata/escape/`)
Programs that must **fail safely** on every node and in CI: fork bomb, memory bomb, output flood, infinite loop, stack bomb, `ptrace`, `mount`, `unshare`, `chroot` escapes, `/proc/self` tricks, symlink/hardlink races, `openat2` path tricks, raw sockets, DNS exfil attempts, `io_uring` abuse, `userfaultfd`, `perf_event_open`, `bpf`, `kexec`, clock manipulation, reading other boxes' files, signaling other PIDs, `/dev/shm`, cgroup escape attempts, long-running zombies, setuid binaries, shared-library injection (`LD_PRELOAD`), core dump tricks, timing probes (rdtsc/cache probes — flagged, not necessarily blocked). Add every new public sandbox CVE's proof-of-concept as a regression case within 7 days of disclosure. External penetration test of the sandbox before the first paying Forge delivery and annually; bug-bounty program by month 12.

## 10. Ops
SLOs (Stage 5): verdict p95 < 4 s warm; `SE` rate < 0.1 %; zero cross-run leakage incidents. Alerts: node canary failure, lease expiry spike, `SE` spike, poison job, disk/cgroup anomalies, seccomp-kill spike (possible attack), unusual outbound traffic from a node.
