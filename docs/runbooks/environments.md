# Environments runbook (Tier-2 nodes, runs, evidence, drills)

For the person operating Tier-2. **Everything here was exercised on one development VM under gVisor (no KVM, no Firecracker). No
production node exists (F32, F68), nothing here has had an external sandbox review (F73), and no result from it may be presented as
microVM-grade.** Read `docs/adr/0034-stage-8-decisions.md` and `docs/adr/0035-build-versus-managed-sandbox.md` first.

## 1. What runs
- **Control plane**: an author creates an environment (spec v2, an image archive pinned by digest, a hidden-material archive pinned by
  SHA-256) and queues runs on the `env` queue. `env_runs.eligible` is a generated column: a gVisor run is eligible for nothing above
  assurance level 1 and not for customer delivery unless the customer opted in (and opting in never raises the level).
- **Tier-2 node**: the Go agent started with `--tier2-runsc`, `--tier2-dir` and `--tier2-elevate 'sudo -n'` leases `env` work when it has
  no judging work. Per run: download the image and hidden archives by presigned URL, check their hashes, unpack them (links are
  stored, never followed; hard links are copied; names that leave the directory are refused), copy the workspace into a memory file
  system, run setup steps then the agent (each its own sandbox, no network), run the verifier in a second sandbox on a snapshot of
  the final workspace with hidden material mounted read-only, compute integrity flags, build the trace and sign it with the node key.
- **Evidence**: the trace holds hashes, never output text. A flag (`protected_path_changed`, `honeypot_touched`, `canary_in_output`,
  `link_in_workspace`) is evidence for a person to look at, never a verdict.

## 2. Setting up a node (development VM; a production node needs the baseline review of `judge/node/README.md`)
1. Install `runsc` and the `gvisor-bin/` directory beside it (checked hash; see the README). Needs cgroup v2 and root. The agent
   itself runs unprivileged and prefixes `runsc`, `mount`, `cp`, `find`, `chown` and `umount` with `--tier2-elevate`; on the
   development VM that is `sudo -n` with passwordless sudo, which is far broader than those six commands. Narrowing it is a
   node-baseline task, not done.
2. Enrol the node as for Tier-1 (docs/runbooks/judge.md); its tiers must include 2.
3. Give `--tier2-dir` a disk with room for an image and its unpacked copy per concurrent run.
4. **Sizing**: host memory per concurrent run is the sandbox's cgroup peak (about 15 MiB idle) **plus the environment's
   `disk_limit_mib`**, because the workspace is a memory file system the node pays for. Do not set concurrency from the cgroup limit alone.
5. End-to-end check: `node apps/api/src/env-e2e-cli.ts` (starts a temporary database and API, enrols a node on the VM, runs an
   honest agent, one that edits the check and one that reads the honeypot). Expected: scores 1, 0, 0; flags none,
   `protected_path_changed`, `honeypot_touched`; all `isolation=gvisor`, `eligible=true`.

## 3. Watching it
```sql
select state, count(*) from env_runs group by 1;                                        -- queued, running, done, failed
select id, state, last_error from jobs where queue = 'env' and state in ('dead','failed') order by updated_at desc limit 20;
select isolation, eligible, count(*) from env_runs where state = 'done' group by 1, 2;  -- gvisor is eligible only up to level 1
```
At startup the node removes sandboxes, cgroups, memory file systems and directories that belong to a node process that no longer exists (it logs how many); a run of a live process is never touched. On the node: `ls /sys/fs/cgroup/aura/` and `grep aura /proc/mounts` should be empty when idle (see F71 for why they may not be);
`ps -eo pid,ppid,stat,cmd | grep runsc` should show nothing when idle except defunct entries owned by init.

## 4. Drill: the guest is compromised
Assume an agent got everything it wanted inside its sandbox. Run on the node: `sudo -E env PATH=$PATH:/usr/local/go/bin
AURA_TIER2_ROOTFS=<rootfs> go test -tags gvisor ./internal/tier2 -run Drill -v`. It runs hostile workloads (CPU spinner, memory hog,
disk flood, background sleepers, a fork bomb) and fails if any process, mount, cgroup or directory of the run survives, if the host
canary changes, or if the next run is not healthy.
If you suspect a real escape: (1) stop the node's agent and stop it taking work and revoke the node (`POST /api/v1/admin/judge-nodes/{id}/revoke`, runbook judge.md; revoked nodes cannot return); (2) do not reuse the
machine, rebuild it; (3) rotate every credential the node held (its node key, presigned-URL access); (4) take the runs it reported
since the suspected time and treat them as evidence only: re-run them elsewhere; their `eligible` flag does not matter, because no
Tier-2 result reaches a credential above level 1; (5) record it in `docs/security/red-team-tier2.md` and tell the owner.

## 5. Red team
Use `docs/security/red-team-tier2.md`: the checklist, the findings table, and what has not been tried.

## 6. Known gaps (so nobody assumes otherwise)
Network allowlist (F69), the archive unpacker running outside a sandbox (F70), stale-sandbox sweep and a reaping supervisor (F71),
customer model endpoints (F72), external review (F73), memory admission control (F74), Firecracker (F68), cost model (F75).
