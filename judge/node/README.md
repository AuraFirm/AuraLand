# Judge node setup (Linux) — UNVERIFIED

Everything in this folder was written on macOS and has **never been run**. It is a starting point for
the person who sets up the first Linux judge node (`docs/owner-tasks.md` section 1.2). Treat every step
as something to verify, and send corrections back.

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
Enroll once with a token from an administrator (`docs/runbooks/judge.md` section 3), then install
`aura-judge.service` from this folder (hardened unit: no new privileges, read-only system, private
tmp, restricted address families, no capabilities beyond what the isolate helper itself needs).

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
