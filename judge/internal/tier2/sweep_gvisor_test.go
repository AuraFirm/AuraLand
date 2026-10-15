//go:build linux && gvisor

package tier2

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A node that died leaves sandboxes, cgroups, memory file systems and directories behind. The sweep removes exactly the runs of
// processes that no longer exist and nothing else: not a live node's run, not a directory that is not one of ours.
func TestSweepRemovesWhatADeadNodeLeftAndSparesTheRest(t *testing.T) {
	g, _ := driver(t)
	const deadPID = 4000000 // above the kernel's pid_max on this machine, so it cannot belong to a live process
	dead := fmt.Sprintf("aura-%d-1", deadPID)
	live := fmt.Sprintf("aura-%d-7", os.Getpid())
	for _, name := range []string{dead, live} {
		if err := os.MkdirAll(filepath.Join(g.BaseDir, name, "state"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(g.BaseDir, name, "work"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(g.BaseDir, name, "marker"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// The dead run's memory file system is still mounted, and its cgroup still exists.
	if out, err := exec.Command("mount", "-t", "tmpfs", "tmpfs", filepath.Join(g.BaseDir, dead, "work")).CombinedOutput(); err != nil {
		t.Fatalf("mount: %v %s", err, out)
	}
	cgroup := filepath.Join(cgroupRoot, dead)
	if err := os.MkdirAll(cgroup, 0o755); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(g.BaseDir, "envrun-123")
	if err := os.MkdirAll(foreign, 0o700); err != nil {
		t.Fatal(err)
	}

	swept, err := g.SweepStale()
	if err != nil || swept != 1 {
		t.Fatalf("swept %d, %v", swept, err)
	}
	for _, gone := range []string{filepath.Join(g.BaseDir, dead), cgroup} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Errorf("%s is still there (%v)", gone, err)
		}
	}
	for _, kept := range []string{filepath.Join(g.BaseDir, live, "marker"), foreign} {
		if _, err := os.Stat(kept); err != nil {
			t.Errorf("%s was removed: %v", kept, err)
		}
	}
	if mounts, _ := os.ReadFile("/proc/self/mountinfo"); strings.Contains(string(mounts), filepath.Join(g.BaseDir, dead)) {
		t.Error("the dead run's mount is still there")
	}
	if again, _ := g.SweepStale(); again != 0 {
		t.Errorf("a second sweep found %d", again)
	}
}
