//go:build linux && gvisor

package tier2

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func replayCase(t *testing.T, g *GVisor, rootfs, agent string) ReplayReport {
	t.Helper()
	ws := workspace(t)
	if err := os.WriteFile(filepath.Join(ws, "input.txt"), []byte("21\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Chown(filepath.Join(ws, "input.txt"), 1000, 1000)
	pristine := t.TempDir()
	if _, err := Snapshot(ws, pristine, 1<<20); err != nil {
		t.Fatal(err)
	}
	spec := SessionSpec{
		Rootfs: rootfs, Workspace: ws, WorkDir: "/work", UID: 1000, GID: 1000, Limits: roomy,
		Setup: [][]string{{"/bin/sh", "-c", "echo ready > /work/setup.txt"}},
		Agent: []string{"/bin/sh", "-c", agent},
	}
	run, err := spec.Run(context.Background(), g)
	if err != nil {
		t.Fatal(err)
	}
	trace, err := BuildTrace(run, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	report, err := Replay(context.Background(), g, spec, trace, pristine)
	if err != nil {
		t.Fatal(err)
	}
	return report
}

func TestADeterministicEnvironmentReplaysEqualAndANondeterministicOneIsCaught(t *testing.T) {
	g, rootfs := driver(t)
	det := replayCase(t, g, rootfs, `n=$(cat /work/input.txt); echo $((n*2)) > /work/answer.txt; cat /work/setup.txt`)
	if !det.Equal {
		t.Fatalf("a deterministic environment must replay equal: %+v", det)
	}
	non := replayCase(t, g, rootfs, `head -c 16 /dev/urandom | od -An -tx1 > /work/answer.txt`)
	if non.Equal || len(non.Differences) == 0 || !strings.Contains(non.Differences[0], "workspace afterwards differs") {
		t.Fatalf("a random environment must not replay equal: %+v", non)
	}
	t.Logf("deterministic: equal; random: %v", non.Differences)
}
