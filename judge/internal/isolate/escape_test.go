//go:build linux && isolate

package isolate

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
)

// The escape regression suite (docs/kit/07 section 9). Every program in testdata/escape/ tries to hurt
// the host or leave its box; each must fail safely. Run on a judge node (or a Linux machine with isolate
// and cgroup v2 delegated to the user) with:
//
//	AURA_ISOLATE_BIN=/usr/local/bin/isolate go test -tags isolate ./internal/isolate -run TestEscape
//
// It has NOT been run yet: the development machine is macOS and a plain Linux container has no systemd
// cgroup delegation for isolate. A node passes this suite or it does not take work.
func TestEscapeSuite(t *testing.T) {
	binary := os.Getenv("AURA_ISOLATE_BIN")
	if binary == "" {
		t.Skip("AURA_ISOLATE_BIN is not set")
	}
	box, err := New(binary, 2)
	if err != nil {
		t.Fatal(err)
	}
	// Programs that must end by a limit or a kill, never by finishing.
	mustBeStopped := map[string][]string{
		"fork_bomb":     {"RTE", "TLE", "MLE"},
		"memory_bomb":   {"MLE"},
		"output_flood":  {"OLE"},
		"infinite_loop": {"TLE"},
		"stack_bomb":    {"RTE", "MLE"},
	}
	// Programs that exit 3 if they got somewhere they must not: any other end is containment.
	mustNotSucceed := []string{
		"ptrace_attach", "mount_attempt", "unshare_attempt", "chroot_attempt", "read_host_files",
		"network_connect", "raw_socket", "write_outside_box", "signal_others", "setuid_root",
	}
	limits := sandbox.Limits{CPUMS: 1000, WallMS: 3000, MemoryKiB: 262144, OutputKiB: 64}
	files, err := filepath.Glob("../../testdata/escape/*.cpp")
	if err != nil || len(files) == 0 {
		t.Fatalf("no escape programs found: %v", err)
	}
	covered := 0
	for _, file := range files {
		name := strings.TrimSuffix(filepath.Base(file), ".cpp")
		source, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		compiled, err := box.Compile(ctx, "cpp", string(source), sandbox.Limits{CPUMS: 20000, WallMS: 60000, MemoryKiB: 1 << 20, OutputKiB: 64})
		if err != nil || !compiled.OK {
			cancel()
			t.Fatalf("%s: could not compile the escape program: %v %s", name, err, compiled.Message)
		}
		run, err := box.Run(ctx, compiled.Program, nil, limits)
		cancel()
		compiled.Program.Release()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if allowed, ok := mustBeStopped[name]; ok {
			covered++
			if !contains(allowed, run.Verdict) {
				t.Errorf("%s: verdict %s, want one of %v", name, run.Verdict, allowed)
			}
			continue
		}
		covered++
		if run.Verdict == "SE" {
			t.Errorf("%s: the sandbox itself failed", name)
		}
		if run.Verdict == "RTE" && run.ExitCode == 3 && !run.Signaled {
			t.Errorf("%s: ESCAPED (the program reached what it must not)", name)
		}
		if !contains(mustNotSucceedNames(mustNotSucceed), name) {
			t.Errorf("%s: no expectation recorded for this escape program", name)
		}
	}
	if covered != len(files) {
		t.Errorf("covered %d of %d escape programs", covered, len(files))
	}
}

func contains(items []string, item string) bool {
	for _, candidate := range items {
		if candidate == item {
			return true
		}
	}
	return false
}

func mustNotSucceedNames(names []string) []string { return names }
