//go:build linux && gvisor

package envnode

import (
	"archive/tar"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/AuraFirm/AuraLand/judge/internal/tier2"
)

// The archive is unpacked inside a gVisor sandbox. Run on the Linux VM as root (see internal/tier2/gvisor_test.go):
//
//	sudo -E env PATH=$PATH:/usr/local/go/bin go test -tags gvisor ./internal/envnode
func sandboxExtractor(t *testing.T, limitMiB int) *SandboxExtractor {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Fatal("run as root (sudo): runsc needs it here")
	}
	helper := filepath.Join(t.TempDir(), "judge")
	build := exec.Command("go", "build", "-o", helper, "../../cmd/aura-judge")
	build.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=linux")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("building the helper: %v\n%s", err, out)
	}
	// t.TempDir makes private directories; the sandbox must be able to walk down to its root file system, as it can under a real node's directory.
	work := t.TempDir()
	for dir := work; dir != "/tmp" && dir != "/"; dir = filepath.Dir(dir) {
		_ = os.Chmod(dir, 0o755)
	}
	rt := &tier2.GVisor{Binary: "/usr/local/bin/runsc", BaseDir: filepath.Join(work, "runs")}
	if err := os.MkdirAll(rt.BaseDir, 0o755); err != nil {
		t.Fatal(err)
	}
	extractor, err := NewSandboxExtractor(context.Background(), rt, helper, filepath.Join(work, "rootfs"), limitMiB)
	if err != nil {
		t.Fatal(err)
	}
	return extractor
}

func writeTar(t *testing.T, reader io.Reader) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "x.tar")
	raw, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSandboxedUnpackGivesTheSameTreeAsTheInProcessOne(t *testing.T) {
	sandboxed := sandboxExtractor(t, 64)
	entries := []entry{
		{tar.Header{Name: "bin/", Typeflag: tar.TypeDir, Mode: 0o755}, ""},
		file("bin/busybox", "payload"),
		{tar.Header{Name: "bin/sh", Typeflag: tar.TypeSymlink, Linkname: "busybox", Mode: 0o777}, ""},
		{tar.Header{Name: "bin/adduser", Typeflag: tar.TypeLink, Linkname: "bin/busybox"}, ""},
		file("etc/passwd", "root:x:0:0"),
	}
	archive := writeTar(t, archive(t, entries...))
	viaSandbox, viaProcess := filepath.Join(t.TempDir(), "a"), filepath.Join(t.TempDir(), "b")
	if err := sandboxed.Extract(context.Background(), archive, viaSandbox); err != nil {
		t.Fatal(err)
	}
	if err := (InProcessExtractor{Limits: DefaultLimits}).Extract(context.Background(), archive, viaProcess); err != nil {
		t.Fatal(err)
	}
	if a, b := describeTree(t, viaSandbox), describeTree(t, viaProcess); a != b {
		t.Fatalf("the trees differ:\nsandbox:\n%s\nin-process:\n%s", a, b)
	}
}

func describeTree(t *testing.T, root string) string {
	t.Helper()
	var lines []string
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || path == root {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			target, _ := os.Readlink(path)
			lines = append(lines, rel+" -> "+target)
		case info.IsDir():
			lines = append(lines, rel+"/")
		default:
			raw, _ := os.ReadFile(path)
			lines = append(lines, rel+" = "+string(raw))
		}
		return nil
	})
	return strings.Join(lines, "\n")
}

func TestSandboxedUnpackRefusesWhatTheRulesRefuseAndWritesNothingOutside(t *testing.T) {
	sandboxed := sandboxExtractor(t, 1)
	parent := t.TempDir()
	hostile := map[string][]entry{
		"a name that leaves the directory": {file("../evil", "x")},
		"an absolute name":                 {file("/etc/evil", "x")},
		"a hard link to a file outside":    {{tar.Header{Name: "b", Typeflag: tar.TypeLink, Linkname: "../../etc/passwd"}, ""}},
		"a file through a link":            {{tar.Header{Name: "l", Typeflag: tar.TypeSymlink, Linkname: "/"}, ""}, file("l/pwned", "x")},
	}
	for name, entries := range hostile {
		into := filepath.Join(parent, strings.ReplaceAll(name, " ", "-"))
		if err := sandboxed.Extract(context.Background(), writeTar(t, archive(t, entries...)), into); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if stray, _ := filepath.Glob(filepath.Join(parent, "evil")); len(stray) != 0 {
		t.Errorf("something was written beside the output: %v", stray)
	}
	if _, err := os.Stat("/etc/evil"); err == nil {
		t.Error("/etc/evil exists")
	}
}

func TestSandboxedUnpackStopsAtItsSizeLimit(t *testing.T) {
	sandboxed := sandboxExtractor(t, 1)
	big := file("big", strings.Repeat("x", 3<<20))
	err := sandboxed.Extract(context.Background(), writeTar(t, archive(t, big)), filepath.Join(t.TempDir(), "out"))
	if err == nil {
		t.Fatal("a 3 MiB file was unpacked under a 1 MiB limit")
	}
}
