# Judge node setup (Linux) — steps 1, 2 and 4 verified once on a development VM

This folder was written on macOS. On 2026-10-12 steps 1, 2 and 4 were run on a development VM (Colima/
Lima, Ubuntu 24.04.4, kernel 6.8, aarch64, systemd, cgroup v2, no KVM needed for isolate). Steps 3 and
5 (the installed agent service and the hardening baseline) are still **unverified**, and the VM is not a
production node. Treat anything not listed under "Verified" as unverified, and send corrections back.

## Verified on 2026-10-12 (development VM)
- Packages: `build-essential git libcap-dev libsystemd-dev pkg-config g++ python3` (plus `asciidoc-base`,
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
sudo apt-get install -y build-essential git libcap-dev libsystemd-dev pkg-config g++ python3 golang-go
```
(The Go toolchain must be at least the version in `judge/go.mod`; install from go.dev if apt is older.)

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
cd judge && go build -o /usr/local/bin/aura-judge ./cmd/aura-judge
sudo useradd --system --home /var/lib/aura-judge --shell /usr/sbin/nologin aura-judge
sudo install -d -o aura-judge -m 0700 /etc/aura /var/lib/aura-judge
```
Build with `GOOS=linux go build -o /usr/local/bin/aura-judge ./cmd/aura-judge`; the agent then runs as
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
