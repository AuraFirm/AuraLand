//go:build linux && gvisor

package tier2

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The Tier-2 escape suite (Stage 8 slice 2). Every probe in testdata/escape is run inside the sandbox, where it must
// exit 0 (contained), and again unconfined as root on the same machine, where it must exit 3 (escaped), so a pass in
// the sandbox cannot be a probe that never could have worked. See the comment in gvisor_test.go for how to run it.
//
// Probes that an unconfined root cannot do on this machine are listed with the reason; there are none today, and a
// control that fails names the probe instead of passing quietly.
const diskLimitMiB = 16

func buildProbe(t *testing.T) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "escape")
	cmd := exec.Command("go", "build", "-o", out, "./testdata/escape")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=linux")
	if raw, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building the probe: %v\n%s", err, raw)
	}
	return out
}

// A harmless process on the host, outside every sandbox, for the probes that try to reach other processes.
func victimPID(t *testing.T) string {
	t.Helper()
	cmd := exec.Command("sleep", "600")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return fmt.Sprint(cmd.Process.Pid)
}

func probeNames(t *testing.T, binary string) []string {
	t.Helper()
	raw, err := exec.Command(binary, "list").Output()
	if err != nil {
		t.Fatal(err)
	}
	names := strings.Fields(string(raw))
	sort.Strings(names)
	if len(names) < 12 {
		t.Fatalf("only %d probes: the suite lost some", len(names))
	}
	return names
}

func TestEscapeSuiteContainedInsideTheSandbox(t *testing.T) {
	g, rootfs := driver(t)
	binary := buildProbe(t)
	canary := filepath.Join(t.TempDir(), "host-canary")
	if err := os.WriteFile(canary, []byte("host secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	victim := victimPID(t)
	for _, name := range probeNames(t, binary) {
		ws := workspace(t)
		raw, _ := os.ReadFile(binary)
		if err := os.WriteFile(filepath.Join(ws, "escape"), raw, 0o755); err != nil {
			t.Fatal(err)
		}
		_ = os.Chown(filepath.Join(ws, "escape"), 1000, 1000)
		env := Env{
			Rootfs: rootfs, Workspace: ws, WorkDir: "/work", UID: 1000, GID: 1000,
			Argv:   []string{"/work/escape", name},
			Env:    []string{"AURA_CANARY=" + canary, "AURA_VICTIM_PID=" + victim, fmt.Sprintf("AURA_DISK_MIB=%d", diskLimitMiB)},
			Limits: Limits{WallSeconds: 30, MemoryMiB: 256, PIDs: 64, DiskMiB: diskLimitMiB, OutputKiB: 64},
		}
		r, err := g.Run(context.Background(), env)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if r.ExitCode != 0 || r.Verdict != "OK" {
			t.Errorf("probe %s ESCAPED or failed: %+v", name, r)
		} else {
			t.Logf("probe %-12s contained", name)
		}
	}
}

func TestEscapeProbesWorkWhenNothingContainsThem(t *testing.T) {
	driver(t) // only to insist on root and a configured machine
	binary := buildProbe(t)
	canary := filepath.Join(t.TempDir(), "host-canary")
	if err := os.WriteFile(canary, []byte("host secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	victim := victimPID(t)
	for _, name := range probeNames(t, binary) {
		dir := t.TempDir()
		cmd := exec.Command(binary, name)
		cmd.Env = append(os.Environ(), "AURA_CANARY="+canary, "AURA_VICTIM_PID="+victim,
			fmt.Sprintf("AURA_DISK_MIB=%d", diskLimitMiB), "AURA_WORKDIR="+dir)
		stderr, err := cmd.CombinedOutput()
		code := 0
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		}
		if code != 3 {
			t.Errorf("control: probe %s exits %d unconfined (%v, %q), so its pass inside the sandbox proves nothing", name, code, err, stderr)
		}
	}
}
