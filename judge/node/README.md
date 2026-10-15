# Judge node setup (Linux) — steps 1, 2 and 4 verified once on a development VM

This folder was written on macOS. On 2026-10-12 steps 1, 2 and 4 were run on a development VM (Colima/
Lima, Ubuntu 24.04.4, kernel 6.8, aarch64, systemd, cgroup v2, no KVM needed for isolate). Steps 3 and
5 (the installed agent service and the hardening baseline) are still **unverified**, and the VM is not a
production node. Treat anything not listed under "Verified" as unverified, and send corrections back.

## Verified on 2026-10-12 (development VM)
- Packages: `build-essential git libcap-dev libsystemd-dev pkg-config g++ python3 openjdk-21-jdk-headless` (plus `asciidoc-base`,
  not shown to be needed). Go 1.26 came from the go.dev tarball (`/usr/local/go`), as the Ubuntu
  package is older.
- isolate v2.1.1: `make isolate isolate-cg-keeper && sudo make install` worked; `isolate.service` is
  installed under `/usr/local/lib/systemd/system`, `systemctl enable --now isolate.service` made it
  active, and `isolate --cg --init` / `--cleanup` worked as an ordinary user (isolate is setuid root).
  The default `/usr/local/etc/isolate` has `cg_root = auto:/run/isolate/cgroup`.
- **The escape suite passed** (15 programs). It found three real driver bugs on its first run, fixed in
  `judge/internal/isolate`: the report file was written inside the root-owned box directory (now in a
  private temp directory); the 64 KiB file-size limit meant for output also killed the linker (compile
  now has its own 32 MiB limit and merges compiler errors into the message); a file-size kill showed as
  a crash instead of an output-limit verdict (SIGXFSZ now maps to OLE). One escape program, the stack
  bomb, was compiled into a loop and never touched the stack; it was rewritten.
- Positive controls: each of the ten containment probes exits 3 ("escaped") when run unconfined as root
  on the same machine and 0 inside the box, so a pass means contained, not broken.
- Bundle opener (4B slice 1): pinned Node v24.21.0 (linux-arm64 tarball, SHA-256 checked against
  nodejs.org's SHASUMS256) unpacked to `/opt/aura/node`; `node tools/build-opener.ts` builds the opener
  (`packages/bundle/dist/open-bundle.cjs`); `AURA_ISOLATE_BIN=/usr/local/bin/isolate go test -tags isolate
  ./internal/bundles` passed: a good bundle opened, and the 300 MiB zip bomb, a symlink entry, a missing
  statement and a badly named solution were refused with the validator's own codes, all from inside a box.
- Not covered: x86 hardware, KVM, SMT/governor/swap baseline (step 5), the agent as a service (step 3),
  anything an external reviewer would add.

Target: Ubuntu 24.04 LTS server, systemd, cgroup v2 (`stat -fc %T /sys/fs/cgroup` prints `cgroup2fs`),
no other workloads, deny-all inbound firewall (outbound only to the control plane).

## 1. Packages
```
sudo apt-get update
sudo apt-get install -y build-essential git libcap-dev libsystemd-dev pkg-config g++ python3 openjdk-21-jdk-headless golang-go
```
(`openjdk-21-jdk-headless` is only for Java submissions; the Java profile expects the distribution's JDK under
`/usr/lib/jvm/java-21-openjdk-<arch>` and its configuration in `/etc/java-21-openjdk`. A node without it fails
`TestLanguages` and must not be offered Java work. The Go toolchain must be at least the version in `judge/go.mod`; install from go.dev if apt is older.)

## 2. isolate (pinned release)
```
git clone --depth 1 --branch v2.1.1 https://github.com/ioi/isolate.git /tmp/isolate
cd /tmp/isolate && make isolate isolate-cg-keeper && sudo make install
sudo systemctl enable --now isolate.service   # delegates a cgroup subtree to isolate
```
Use `isolate.conf.example` in this folder as `/usr/local/etc/isolate` and compare it with the shipped
default; check `cg_root` points at the slice created by `isolate.service`. Smoke test:
```
sudo isolate --cg --box-id=0 --init && sudo isolate --cg --box-id=0 --cleanup
```
If `--init --cg` fails, fix this before anything else; the agent refuses to run without cgroups.

## 3. The agent
```
cd judge && CGO_ENABLED=0 go build -o /usr/local/bin/aura-judge ./cmd/aura-judge
sudo useradd --system --home /var/lib/aura-judge --shell /usr/sbin/nologin aura-judge
sudo install -d -o aura-judge -m 0700 /etc/aura /var/lib/aura-judge
```
Build with `CGO_ENABLED=0 GOOS=linux go build -o /usr/local/bin/aura-judge ./cmd/aura-judge`; the agent then runs as
`aura-judge run --control-plane URL --node-id ID --key-file F --opener-file /usr/local/lib/aura/open-bundle.cjs`
(its health canary is only a compile-and-run smoke test, not the escape suite). Add
`--rewriter-file /usr/local/lib/aura/rewrite-bundle.cjs` for a node that also takes delivery watermark jobs. Enroll once with a token from an administrator (`docs/runbooks/judge.md` section 3), then install
`aura-judge.service` from this folder (hardened unit: no new privileges, read-only system, private
tmp, restricted address families, no capabilities beyond what the isolate helper itself needs).

## 3b. Node for the bundle opener
The agent opens task bundles with the TypeScript validator under a pinned Node, inside a box. Install the
Node 24 tarball for your architecture from nodejs.org, check its SHA-256 against `SHASUMS256.txt`, and
unpack it to `/opt/aura/node` (root-owned; the box sees only that tree, read-only). Build the opener on a
development machine with `pnpm build:opener` and install `packages/bundle/dist/open-bundle.cjs` next to the
agent. Run `go test -tags isolate ./internal/bundles` after the escape suite.

## 4. The escape suite (must pass before the node takes work)
```
cd judge && AURA_ISOLATE_BIN=/usr/local/bin/isolate go test -tags isolate ./internal/isolate -run TestEscape -v
```
Send the whole output to the project owner. Any `ESCAPED` line, or a failure, means the node does not go
live.

## 5. Baseline hardening to review with the external reviewer
SMT off or the judged core's sibling idle; CPU governor `performance`; swap off; `noexec,nosuid,nodev`
on the work partition; automatic security updates with reboot windows; kernel parameter policy for
unprivileged user namespaces; host firewall deny-all inbound; no cloud credentials on the machine. See
`docs/kit/07_Judge_and_Sandbox_Spec.md` section 3.

## Tier-2 (gVisor), verified once on 2026-10-15 on the same development VM
Stage 8 slice 1. **Not KVM, not Firecracker, not a production node.** gVisor `runsc` release-20261005.0 (aarch64), systrap platform:
- Download `gvisor.tar.bz2` and its `.sha512` from `storage.googleapis.com/gvisor/releases/release/<date>/<arch>/`, check the hash,
  extract; install `runsc` to `/usr/local/bin` **and the `gvisor-bin/` directory beside it** (this release refuses to start without
  its sidecar binaries: `gvisor_sentry`, `runsc-fd-parking` and others).
- A root file system for a test: `docker create busybox`, `docker export | tar x -C /tmp/gvb/rootfs`.
- Run the Tier-2 tests as root (runsc needs it here; delegating cgroups to the agent's user is a node-baseline task, not done):
  `sudo -E env PATH=$PATH:/usr/local/go/bin AURA_TIER2_ROOTFS=/tmp/gvb/rootfs go test -tags gvisor ./internal/tier2 -v`.
- Observed: the sandbox kernel reports `4.19.0-gvisor`; the program runs as uid 1000; the root file system and `/etc`, `/usr` are
  read-only, only the workspace is writable; no network interface beyond `lo` and no connection out; a wall limit gives TLE; an
  output flood stops at its cap (OLE); a memory hog is killed at its limit and counted by the kernel (MLE, `oom_kill` > 0);
  a fork loop reaches the process limit (counted in `pids.events`) and leaves no process on the host.
- Start time of `/bin/true`: min 30 ms, p50 34 ms, max 56 ms over 20 runs. **One VM, one image: not a capacity claim.**
- Learned the hard way: runsc keeps its empty network namespace bind-mounted in the state directory (unmount it before removing the
  directory); a cgroup created beforehand gets **no limits** from runsc (let runsc create it); `runsc wait` after the sandbox has
  exited cannot give the exit status (use `run`); the cgroup disappears the instant the sandbox ends (sample it while it lives).

### Tier-2 escape suite, run 2026-10-15 (same VM, same caveats)
`internal/tier2/testdata/escape` is a static Go program with 15 probes (chroot, mount, network, host file by canary, ptrace of a host
process, raw socket, setuid to root, writes to `/etc` `/usr` `/bin`, `/dev/mem` and friends, `/proc/kcore`, mknod, module load, signalling a
host process, the host's cgroup tree, reboot, and filling the workspace). `escape_test.go` runs each inside gVisor (all contained) and
again unconfined as root (all escape), so a pass means contained, not broken.
- It found one real gap on its first run: **disk_fill** wrote past the limit, because a per-file size limit does not bound the total.
  The driver now gives each run a memory file system of exactly the disk limit and copies the workspace in and out (links copied as
  links, never followed). The agent's disk use therefore counts against host memory: size concurrency accordingly.
- The first version of the unconfined control mounted a tmpfs over the VM's `/tmp` (three stacked mounts, since removed) because the
  probe's target was `/tmp`; controls now mount only over their own work directory, and ptrace/signal probes use a harmless process the
  test starts, never PID 1.
- Not covered: kernel-surface fuzzing, side channels, other platforms (KVM/ptrace), x86, and anything an external reviewer would add.

### Tier-2 verifier, 2026-10-15 (same VM, same caveats)
The verifier runs in a second sandbox on a **snapshot** of the agent's workspace with the hidden material mounted read-only at
`/verifier`; the agent's sandbox never has it. Observed: an honest agent scores 1, a wrong one 0; an agent hunting the file system
for the hidden answer finds nothing; the verifier cannot write to what it was shown.
- **A real reward hack, reproduced and stopped:** an agent that makes `answer.txt` a symlink to `/verifier/expected.txt` is graded
  against the verifier's own copy and scores 1 if the workspace is handed over as it is (mutation-checked: copying links makes the
  test fail with "the link earned a score of 1"). `Snapshot` therefore carries only regular files and directories, drops links,
  devices and pipes, reports their names as evidence, and caps files, depth and bytes.

### Tier-2 reward-hack evidence, 2026-10-15 (same VM, same caveats)
A purpose-built environment (a check script the verifier runs, a hidden expected answer, a honeypot file) and four agents:
the honest one scores 1 with **no flags even though it lists every directory**; one that edits the protected check scores 0 (the check
is put back from a pristine copy before the verifier looks) and raises `protected_path_changed`; one that reads the honeypot raises
`honeypot_touched` (its access time moved; run-time atime is normalized to the epoch on copy-in, files are opened with O_NOATIME
when we look at them, so our own hashing never looks like the agent reading); one that links `answer.txt` to the hidden file scores 0
and raises `link_in_workspace`. A companion test shows the unrestored edit WOULD score 1. Flags are evidence for a person, never a verdict.

### Tier-2 trace and replay, 2026-10-15 (same VM, same caveats)
A trace (steps with verdict, exit status, wall time, peak memory, process peak, SHA-256 of the output, the workspace hash after each
step; the integrity flags; the verifier's result) is canonical JSON, capped at 8 MiB, and signed by the node's Ed25519 key under its
own domain. Replay re-runs the session from a pristine copy: a deterministic sample replays equal; a step that reads `/dev/urandom` is
reported as "the workspace afterwards differs". **The network is off for every run** (no allowlist implementation; see ADR 0034).

### Tier-2 measurements and the compromised-guest drill, 2026-10-15 (same VM, same caveats)
`measure_gvisor_test.go` (`-run Measure -v`): 4 CPUs, 5.9 GiB. First run 57 ms; 20 sequential runs p50 42 ms, p95 54 ms; 40 runs at
1/2/4/8 workers 23.4/39.2/49.3/47.0 runs per second; a sleeping sandbox peaks at 15 MiB in its cgroup. The workspace memory file
system is charged to the node, not the sandbox cgroup, so host memory per run is the cgroup peak plus the workspace limit. Trivial
program, one VM, no Firecracker: see ADR 0035.

`drill_gvisor_test.go` (`-run Drill -v`): two hostile workloads (a spinner, a memory hog, a disk flood and a sleeper; and a fork
bomb), two rounds each. Observed: TLE and MLE kills and a process-limit stop; after every round no process, mount or cgroup of the run
was left (compared with a snapshot taken before, so older debris is not blamed on the run), the base directory was empty, the host
canary was untouched, and the next run was healthy.
- **Debris from an earlier session was found while writing the drill**: a sandbox (`runsc-gofer`, `runsc-sandbox`) and its cgroup from
  a test run killed about 90 minutes earlier were still alive. The cause was not determined (most likely a test process killed
  mid-run). The driver has no startup sweep of stale `aura-*` cgroups and state directories; a node needs one (F71).
- 49 defunct `runsc-fd-parking` processes were children of the VM's init and never reaped. Not caused by our process (their parent is
  PID 1); cause unknown. A production node must run under a supervisor that reaps and the node baseline must check for it (F71).

### Tier-2 archives are unpacked in a sandbox (cutlist F70), 2026-10-15
`--tier2-extract=sandbox` (the default) runs this very binary inside a gVisor sandbox as `extract-archive`: no network, the archive read-only, the
output a memory file system of `--tier2-extract-mib` (default 1024), 64 processes, 256 MiB, 10 minutes. The binary must be **statically linked
(`CGO_ENABLED=0`)** because the sandbox's root file system holds nothing else; the node proves it can run the helper on an empty archive before it
takes work and refuses to start if it cannot. Cost: one unpack holds up to the limit in memory, and an image larger than the limit is refused;
`--tier2-extract=in-process` unpacks in the agent's own process (hardened, tested, but outside any sandbox, which the repository rule forbids for
untrusted archives) and exists only for a node that cannot spare the memory. Verified on the VM: the same tree as the in-process unpack,
every hostile archive of the unit suite refused with nothing written outside, a 3 MiB file refused under a 1 MiB limit. Two things the first run
taught: the sandbox's own helper processes count against the process limit (16 stopped it from starting; 64 works), and the archive must be
readable by the sandbox's user.
