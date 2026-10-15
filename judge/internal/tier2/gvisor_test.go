//go:build linux && gvisor

package tier2

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// These tests run real gVisor and need root, runsc, and a root file system (a busybox image exported to a
// directory) named by AURA_TIER2_ROOTFS. Run them on the Linux dev VM:
//
//	sudo -E env PATH=$PATH:/usr/local/go/bin AURA_TIER2_ROOTFS=/tmp/gvb/rootfs go test -tags gvisor ./internal/tier2 -v
func driver(t *testing.T) (*GVisor, string) {
	t.Helper()
	rootfs := os.Getenv("AURA_TIER2_ROOTFS")
	if rootfs == "" {
		t.Fatal("AURA_TIER2_ROOTFS is not set (a busybox root file system); see the comment at the top of this file")
	}
	if os.Geteuid() != 0 {
		t.Fatal("run as root (sudo): runsc needs it here")
	}
	return &GVisor{Binary: "/usr/local/bin/runsc", BaseDir: t.TempDir()}, rootfs
}

func workspace(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chown(dir, 1000, 1000); err != nil {
		t.Fatal(err)
	}
	return dir
}

func run(t *testing.T, script string, limits Limits) (Result, string) {
	t.Helper()
	g, rootfs := driver(t)
	ws := workspace(t)
	env := Env{Rootfs: rootfs, Workspace: ws, WorkDir: "/work", Argv: []string{"/bin/sh", "-c", script}, UID: 1000, GID: 1000, Limits: limits}
	result, err := g.Run(context.Background(), env)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	return result, ws
}

var roomy = Limits{WallSeconds: 20, MemoryMiB: 128, PIDs: 64, DiskMiB: 64, OutputKiB: 64}

func TestRunsAsAnUnprivilegedUserInsideGVisor(t *testing.T) {
	r, _ := run(t, `echo "kernel=$(uname -r) uid=$(id -u)"`, roomy)
	out := string(r.Stdout)
	if r.Verdict != "OK" || r.Isolation != "gvisor" || !strings.Contains(out, "gvisor") || !strings.Contains(out, "uid=1000") {
		t.Fatalf("got %+v %q", r, out)
	}
}

func TestAFailingExitIsStillTheAgentFinishing(t *testing.T) {
	r, _ := run(t, `exit 3`, roomy)
	if r.Verdict != "OK" || r.ExitCode != 3 || r.Signaled {
		t.Fatalf("got %+v", r)
	}
}

func TestWorkspaceIsWritableAndTheRestIsNot(t *testing.T) {
	r, ws := run(t, `echo kept > /work/out.txt; touch /etc/x 2>/dev/null && echo ETC_WRITABLE; touch /usr/x 2>/dev/null && echo USR_WRITABLE; ls /work`, roomy)
	if strings.Contains(string(r.Stdout), "WRITABLE") {
		t.Fatalf("the root file system is writable: %q", r.Stdout)
	}
	b, err := os.ReadFile(filepath.Join(ws, "out.txt"))
	if err != nil || strings.TrimSpace(string(b)) != "kept" {
		t.Fatalf("workspace write lost: %v %q", err, b)
	}
}

func TestTheWallLimitKillsAndReportsTLE(t *testing.T) {
	started := time.Now()
	r, _ := run(t, `sleep 60`, Limits{WallSeconds: 2, MemoryMiB: 128, PIDs: 64, DiskMiB: 64, OutputKiB: 64})
	if r.Verdict != "TLE" || time.Since(started) > 15*time.Second {
		t.Fatalf("got %+v after %v", r, time.Since(started))
	}
}

func TestTheOutputLimitStopsAFloodAndReportsOLE(t *testing.T) {
	started := time.Now()
	r, _ := run(t, `yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, Limits{WallSeconds: 20, MemoryMiB: 128, PIDs: 64, DiskMiB: 64, OutputKiB: 64})
	if r.Verdict != "OLE" || len(r.Stdout) > 64<<10 || time.Since(started) > 15*time.Second {
		t.Fatalf("got %s with %d bytes after %v", r.Verdict, len(r.Stdout), time.Since(started))
	}
}

func TestAMemoryHogDoesNotSurviveItsLimit(t *testing.T) {
	r, _ := run(t, `x=$(head -c 400000000 /dev/zero | tr '\0' a); echo ${#x}`, Limits{WallSeconds: 30, MemoryMiB: 64, PIDs: 64, DiskMiB: 64, OutputKiB: 64})
	t.Logf("memory hog: verdict=%s exit=%d stdout=%q diagnostics=%q", r.Verdict, r.ExitCode, r.Stdout, r.Diagnostics)
	if r.Verdict != "MLE" || r.OOMKills < 1 || r.PeakMemoryMiB > 64 {
		t.Fatalf("want a memory-limit kill counted by the kernel and a peak within the limit, got %+v", r)
	}
	if strings.Contains(string(r.Stdout), "400000000") {
		t.Fatalf("the program allocated 400 MB under a 64 MiB limit")
	}
}

func TestAForkBombIsBoundedByThePidLimit(t *testing.T) {
	r, _ := run(t, `i=0; while [ $i -lt 400 ]; do sleep 100 & i=$((i+1)); done 2>/dev/null; ps | grep -c '[s]leep 100'`, Limits{WallSeconds: 8, MemoryMiB: 128, PIDs: 32, DiskMiB: 64, OutputKiB: 64})
	t.Logf("fork bomb: verdict=%s pidsLimitHit=%v peak=%d", r.Verdict, r.PidsLimitHit, r.PidsPeak)
	if !r.PidsLimitHit {
		t.Fatalf("the kernel did not count the process limit being reached: %+v", r)
	}
	if r.PidsPeak < 1 || r.PidsPeak > 32 {
		t.Fatalf("the process count peaked at %d under a limit of 32", r.PidsPeak)
	}
	out, _ := exec.Command("pgrep", "-c", "-x", "sleep").Output()
	if n := strings.TrimSpace(string(out)); n != "" && n != "0" {
		t.Fatalf("%s sleep processes survive on the host", n)
	}
}

func TestThereIsNoNetworkAndNoHostFileSystem(t *testing.T) {
	r, _ := run(t, `ls /sys/class/net 2>/dev/null; cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d ' '; ls / | tr '\n' ' '; nc -w 2 1.1.1.1 53 </dev/null && echo CONNECTED`, roomy)
	out := string(r.Stdout)
	if strings.Contains(out, "CONNECTED") || strings.Contains(out, "eth") {
		t.Fatalf("network reachable: %q", out)
	}
	for _, host := range []string{"Users", "Developer", "AuraLand"} {
		if strings.Contains(out, host) {
			t.Fatalf("host path %s visible: %q", host, out)
		}
	}
}

func TestStartTimesAreMeasured(t *testing.T) {
	g, rootfs := driver(t)
	ws := workspace(t)
	env := Env{Rootfs: rootfs, Workspace: ws, WorkDir: "/work", Argv: []string{"/bin/true"}, UID: 1000, GID: 1000, Limits: roomy}
	var ms []int
	for i := 0; i < 20; i++ {
		r, err := g.Run(context.Background(), env)
		if err != nil || r.Verdict != "OK" {
			t.Fatalf("run %d: %v %+v", i, err, r)
		}
		ms = append(ms, r.WallMS)
	}
	sort.Ints(ms)
	t.Logf("20 runs of /bin/true under gvisor (systrap, this VM): min=%d ms p50=%d ms max=%d ms", ms[0], ms[len(ms)/2], ms[len(ms)-1])
}
