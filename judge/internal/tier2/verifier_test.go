package tier2

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseVerifierOutputAcceptsOnlyAResultLine(t *testing.T) {
	good := map[string]float64{
		`{"score": 1, "detail": "all"}`:                            1,
		"noise\nmore noise\n{\"score\": 0.25, \"detail\": \"\"}\n": 0.25,
		`{"score":0,"detail":"tab\there"}`:                         0,
	}
	for text, want := range good {
		got, _, err := ParseVerifierOutput([]byte(text))
		if err != nil || got != want {
			t.Errorf("%q: got %v %v", text, got, err)
		}
	}
	bad := []string{
		``, "\n\n", `not json`, `{"score": 2, "detail": ""}`, `{"score": -0.1, "detail": ""}`,
		`{"score": 1, "detail": "", "extra": "smuggled"}`, `{"score": 1} {"score": 0}`,
		`{"score": 1, "detail": "` + strings.Repeat("a", 1025) + `"}`, "{\"score\": 1, \"detail\": \"bell\\u0007\"}",
		`{"score": "1", "detail": ""}`, `{"detail": "no score"}`,
	}
	for _, text := range bad {
		if _, _, err := ParseVerifierOutput([]byte(text)); err == nil {
			t.Errorf("%q was accepted", text)
		}
	}
}

func TestSnapshotCopiesFilesAndRefusesToCarryLinks(t *testing.T) {
	src, dst := t.TempDir(), filepath.Join(t.TempDir(), "snap")
	_ = os.MkdirAll(filepath.Join(src, "sub"), 0o755)
	_ = os.WriteFile(filepath.Join(src, "answer.txt"), []byte("42"), 0o700)
	_ = os.WriteFile(filepath.Join(src, "sub", "x"), []byte("x"), 0o755)
	_ = os.Symlink("/verifier/expected.txt", filepath.Join(src, "stolen.txt"))
	_ = os.Symlink("sub/x", filepath.Join(src, "innocent-looking"))
	report, err := Snapshot(src, dst, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if report.Files != 2 || len(report.Dropped) != 2 || report.Dropped[0] != "innocent-looking" || report.Dropped[1] != "stolen.txt" {
		t.Fatalf("got %+v", report)
	}
	for _, name := range []string{"stolen.txt", "innocent-looking"} {
		if _, err := os.Lstat(filepath.Join(dst, name)); err == nil {
			t.Errorf("%s was carried over", name)
		}
	}
	info, _ := os.Stat(filepath.Join(dst, "answer.txt"))
	if info.Mode().Perm() != 0o644 {
		t.Errorf("modes are normalized, got %v", info.Mode().Perm())
	}
}

func TestSnapshotStopsAtItsCaps(t *testing.T) {
	src := t.TempDir()
	_ = os.WriteFile(filepath.Join(src, "big"), make([]byte, 2048), 0o644)
	if _, err := Snapshot(src, filepath.Join(t.TempDir(), "s"), 1024); err == nil {
		t.Error("a file over the byte allowance was copied")
	}
	deep := src
	for i := 0; i < snapshotDepthMax+2; i++ {
		deep = filepath.Join(deep, "d")
	}
	_ = os.MkdirAll(deep, 0o755)
	if _, err := Snapshot(src, filepath.Join(t.TempDir(), "s2"), 1<<20); err == nil {
		t.Error("a tree deeper than the cap was copied")
	}
}

func TestMountsAreReadOnlyAndCannotCoverTheWorkspaceOrTheRoot(t *testing.T) {
	e := goodEnv()
	e.Mounts = []Mount{{Host: "/var/lib/aura/hidden/1", Dest: "/verifier"}}
	raw, err := Spec(e)
	if err != nil || !strings.Contains(string(raw), `"ro"`) {
		t.Fatalf("a mount must be read-only: %v %s", err, raw)
	}
	for _, m := range []Mount{{"/", "/verifier"}, {"hidden", "/verifier"}, {"/h", "verifier"}, {"/h", "/"}, {"/h", "/work"}, {"/h", "/proc/x"}, {"/h", "/tmp/y"}, {"/h", "/a/../b"}} {
		e := goodEnv()
		e.Mounts = []Mount{m}
		if _, err := Spec(e); err == nil {
			t.Errorf("mount %+v was accepted", m)
		}
	}
}
