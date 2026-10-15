package tier2

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// fake is a Runtime that runs nothing: it applies a function to the workspace and answers.
type fake struct {
	calls []Env
	do    func(call int, env Env) Result
}

func (f *fake) Run(_ context.Context, env Env) (Result, error) {
	f.calls = append(f.calls, env)
	r := f.do(len(f.calls), env)
	r.Isolation = IsolationGVisor
	return r, nil
}

func newSpec(t *testing.T) SessionSpec {
	t.Helper()
	ws := t.TempDir()
	if err := os.WriteFile(filepath.Join(ws, "seed.txt"), []byte("seed"), 0o644); err != nil {
		t.Fatal(err)
	}
	return SessionSpec{
		Rootfs: "/rootfs", Workspace: ws, WorkDir: "/work", UID: 1000, GID: 1000,
		Setup: [][]string{{"prepare"}}, Agent: []string{"agent"},
		Limits: Limits{WallSeconds: 60, MemoryMiB: 128, PIDs: 16, DiskMiB: 16, OutputKiB: 16},
	}
}

func TestSessionRunsSetupThenAgentAndHashesTheWorkspaceAfterEach(t *testing.T) {
	spec := newSpec(t)
	rt := &fake{do: func(call int, env Env) Result {
		name := []string{"setup.txt", "answer.txt"}[call-1]
		_ = os.WriteFile(filepath.Join(env.Workspace, name), []byte(name), 0o644)
		return Result{Verdict: "OK"}
	}}
	got, err := spec.Run(context.Background(), rt)
	if err != nil {
		t.Fatal(err)
	}
	if got.Outcome != "completed" || len(got.Steps) != 2 || got.Steps[0].Name != "setup 1" || got.Steps[1].Name != "agent" {
		t.Fatalf("got %+v", got)
	}
	if got.StartHash == got.Steps[0].TreeHash || got.Steps[0].TreeHash == got.Steps[1].TreeHash {
		t.Fatal("each step changed the workspace, so the hashes must differ")
	}
	if rt.calls[0].Argv[0] != "prepare" || rt.calls[1].Argv[0] != "agent" {
		t.Fatal("setup runs before the agent")
	}
}

func TestSessionStopsAtAFailedSetupAndSharesOneWallBudget(t *testing.T) {
	spec := newSpec(t)
	spec.Setup = [][]string{{"a"}, {"b"}}
	rt := &fake{do: func(call int, _ Env) Result {
		if call == 1 {
			return Result{Verdict: "OK", ExitCode: 2}
		}
		return Result{Verdict: "OK"}
	}}
	got, _ := spec.Run(context.Background(), rt)
	if got.Outcome != "setup_failed" || len(got.Steps) != 1 || len(rt.calls) != 1 {
		t.Fatalf("a failed setup command must stop everything after it: %+v", got)
	}
	if rt.calls[0].Limits.WallSeconds != 60 {
		t.Fatalf("the first step gets the whole budget, got %d", rt.calls[0].Limits.WallSeconds)
	}
}

func TestHashTreeIsStableSeesChangesAndNeverFollowsLinks(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret")
	_ = os.WriteFile(outside, []byte("one"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "a"), []byte("a"), 0o644)
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	first, _ := HashTree(dir)
	again, _ := HashTree(dir)
	if first != again {
		t.Fatal("hashing twice must agree")
	}
	_ = os.WriteFile(outside, []byte("two"), 0o600) // the link's target changed, the tree did not
	if h, _ := HashTree(dir); h != first {
		t.Fatal("the hash followed a link out of the tree")
	}
	_ = os.WriteFile(filepath.Join(dir, "a"), []byte("b"), 0o644)
	if h, _ := HashTree(dir); h == first {
		t.Fatal("a content change must change the hash")
	}
	changed, _ := HashTree(dir)
	_ = os.Chmod(filepath.Join(dir, "a"), 0o600)
	if h, _ := HashTree(dir); h == changed {
		t.Fatal("a permission change must change the hash")
	}
}
