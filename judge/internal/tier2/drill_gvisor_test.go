//go:build linux && gvisor

package tier2

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The compromised-guest drill (Stage 8 slice 10, docs/runbooks/environments.md section "Drill"). Assume the agent is fully
// hostile and does every nuisance at once: a fork bomb, a memory hog, an output flood, a file flood, and background
// processes that try to outlive the run. Whatever the verdict, the node must end up as it started: no process, mount,
// cgroup or directory of the run left behind, the host canary untouched, and the next run healthy. A drill that only checks
// the verdict would pass while a node slowly filled with debris.
// Two hostile workloads. The first stays alive (a spinner, a memory hog, a disk flood and a sleeper), so a limit has to kill
// processes that are still running; the second is a fork bomb, which the process limit has to stop.
var hostileScripts = map[string]string{
	"stays-alive": `
sh -c 'while :; do : ; done' &
sh -c 'x=a; while :; do x="$x$x$x$x"; done' &
yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > /work/flood &
for i in $(seq 1 500); do touch /work/f$i 2>/dev/null; done
sleep 30`,
	"fork-bomb": `( while :; do sleep 1000 & done ) & ( while :; do sh -c "sleep 1000 &" ; done ) & sleep 30`,
}

// hostFacts lists what exists on the host now; the drill compares two snapshots, so debris from some earlier run on a
// shared machine is not blamed on this one.
func hostFacts(t *testing.T, base string) (processes, mounts, cgroups []string) {
	t.Helper()
	out, _ := exec.Command("pgrep", "-af", base).Output()
	for _, line := range strings.Split(string(out), "\n") {
		// pgrep -f matches its own command line too; ignore it.
		if line != "" && !strings.Contains(line, "pgrep") {
			processes = append(processes, line)
		}
	}
	raw, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.Contains(line, base) {
			mounts = append(mounts, line)
		}
	}
	found, _ := filepath.Glob("/sys/fs/cgroup/aura/aura-*")
	return processes, mounts, append(cgroups, found...)
}

func newOnly(before, after []string) []string {
	known := map[string]bool{}
	for _, item := range before {
		known[item] = true
	}
	var fresh []string
	for _, item := range after {
		if !known[item] {
			fresh = append(fresh, item)
		}
	}
	return fresh
}

func TestCompromisedGuestDrillLeavesTheNodeAsItWasFound(t *testing.T) {
	g, rootfs := driver(t)
	_, _, cgroupsBefore := hostFacts(t, g.BaseDir)
	canary := filepath.Join(t.TempDir(), "host-canary")
	if err := os.WriteFile(canary, []byte("host secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	limits := Limits{WallSeconds: 3, MemoryMiB: 128, PIDs: 64, DiskMiB: 16, OutputKiB: 64}
	for name, script := range hostileScripts {
		for round := 1; round <= 2; round++ {
			ws := workspace(t)
			r, err := g.Run(context.Background(), Env{Rootfs: rootfs, Workspace: ws, WorkDir: "/work", UID: 1000, GID: 1000,
				Argv: []string{"/bin/sh", "-c", script}, Limits: limits})
			if err != nil {
				t.Fatalf("%s round %d: %v", name, round, err)
			}
			// Something must have stopped it: a limit verdict, or (a fork bomb that starves its own script) the process limit.
			if r.Verdict == "SE" || (r.Verdict == "OK" && !r.PidsLimitHit) {
				t.Errorf("%s round %d: verdict %q with no limit reached: %+v", name, round, r.Verdict, r)
			}
			t.Logf("%s round %d: verdict %s, %d ms, peak %d MiB, pids peak %d", name, round, r.Verdict, r.WallMS, r.PeakMemoryMiB, r.PidsPeak)
			processes, mounts, cgroupsAfter := hostFacts(t, g.BaseDir)
			if cgroups := newOnly(cgroupsBefore, cgroupsAfter); len(processes) != 0 || len(mounts) != 0 || len(cgroups) != 0 {
				t.Fatalf("%s round %d left debris: processes=%v mounts=%v cgroups=%v", name, round, processes, mounts, cgroups)
			}
			if left, _ := os.ReadDir(g.BaseDir); len(left) != 0 {
				t.Fatalf("%s round %d left directories in the base dir: %v", name, round, left)
			}
		}
	}
	if raw, err := os.ReadFile(canary); err != nil || string(raw) != "host secret" {
		t.Fatalf("the host canary changed: %v %q", err, raw)
	}
	// The node still works after being abused.
	after, _ := run(t, `echo healthy`, roomy)
	if after.Verdict != "OK" || !strings.Contains(string(after.Stdout), "healthy") {
		t.Fatalf("the next run was not healthy: %+v", after)
	}
}
