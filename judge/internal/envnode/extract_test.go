package envnode

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type entry struct {
	header tar.Header
	body   string
}

func archive(t *testing.T, entries ...entry) *bytes.Reader {
	t.Helper()
	var buf bytes.Buffer
	w := tar.NewWriter(&buf)
	for _, e := range entries {
		h := e.header
		h.Size = int64(len(e.body))
		if err := w.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(e.body))
	}
	_ = w.Close()
	return bytes.NewReader(buf.Bytes())
}

func file(name, body string) entry {
	return entry{tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0o644}, body}
}

func TestExtractLaysOutFilesDirectoriesAndLinks(t *testing.T) {
	dir := t.TempDir()
	err := Extract(archive(t,
		entry{tar.Header{Name: "bin/", Typeflag: tar.TypeDir, Mode: 0o755}, ""},
		file("bin/sh", "busybox"),
		entry{tar.Header{Name: "bin/ls", Typeflag: tar.TypeSymlink, Linkname: "sh", Mode: 0o777}, ""},
		entry{tar.Header{Name: "dev/null", Typeflag: tar.TypeChar, Mode: 0o666}, ""},
	), dir, DefaultLimits)
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "bin/sh")); string(b) != "busybox" {
		t.Fatal("file lost")
	}
	if target, _ := os.Readlink(filepath.Join(dir, "bin/ls")); target != "sh" {
		t.Fatal("link lost")
	}
	if _, err := os.Lstat(filepath.Join(dir, "dev/null")); err == nil {
		t.Fatal("a device node was created")
	}
}

func TestExtractRefusesEveryWayOutOfTheDirectory(t *testing.T) {
	outside := t.TempDir()
	cases := map[string][]entry{
		"absolute name":        {file("/etc/passwd", "x")},
		"parent segment":       {file("../escape", "x")},
		"nested parent":        {file("a/../../escape", "x")},
		"hard link to nothing": {{tar.Header{Name: "b", Typeflag: tar.TypeLink, Linkname: "a"}, ""}},
		"hard link outside":    {{tar.Header{Name: "b", Typeflag: tar.TypeLink, Linkname: "../a"}, ""}},
		"hard link to a link":  {{tar.Header{Name: "s", Typeflag: tar.TypeSymlink, Linkname: outside, Mode: 0o777}, ""}, {tar.Header{Name: "b", Typeflag: tar.TypeLink, Linkname: "s"}, ""}},
		"through a link":       {{tar.Header{Name: "link", Typeflag: tar.TypeSymlink, Linkname: outside, Mode: 0o777}, ""}, file("link/pwned", "x")},
		"deeper link path":     {{tar.Header{Name: "l", Typeflag: tar.TypeSymlink, Linkname: outside}, ""}, file("l/sub/pwned", "x")},
	}
	for name, entries := range cases {
		dir := t.TempDir()
		if err := Extract(archive(t, entries...), dir, DefaultLimits); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("something was written outside: %v", entries)
	}
}

func TestExtractStopsAtItsCaps(t *testing.T) {
	small := ExtractLimits{Entries: 3, Bytes: 10, Depth: 3}
	if err := Extract(archive(t, file("a", "1"), file("b", "2"), file("c", "3"), file("d", "4")), t.TempDir(), small); err == nil {
		t.Error("too many entries")
	}
	if err := Extract(archive(t, file("a", strings.Repeat("x", 11))), t.TempDir(), small); err == nil {
		t.Error("too many bytes")
	}
	if err := Extract(archive(t, file("a/b/c/d", "x")), t.TempDir(), small); err == nil {
		t.Error("too deep")
	}
}

// Real images carry hard links (busybox has hundreds): the extra names must hold the same bytes without multiplying them.
func TestExtractMakesAHardLinkToAnUnpackedFile(t *testing.T) {
	dir := t.TempDir()
	link := entry{tar.Header{Name: "bin/adduser", Typeflag: tar.TypeLink, Linkname: "bin/busybox"}, ""}
	if err := Extract(archive(t, file("bin/busybox", "payload"), link), dir, DefaultLimits); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "bin/adduser"))
	if err != nil || string(raw) != "payload" {
		t.Fatalf("link = %q, %v", raw, err)
	}
	a, _ := os.Stat(filepath.Join(dir, "bin/busybox"))
	b, _ := os.Stat(filepath.Join(dir, "bin/adduser"))
	if !os.SameFile(a, b) {
		t.Fatal("the hard link is a second copy")
	}
}

// A thousand names for a 1 MiB file must not count as a thousand MiB.
func TestExtractDoesNotCountALinkAsBytes(t *testing.T) {
	entries := []entry{file("big", strings.Repeat("x", 1<<20))}
	for i := 0; i < 50; i++ {
		entries = append(entries, entry{tar.Header{Name: "l" + string(rune('a'+i%26)) + string(rune('a'+i/26)), Typeflag: tar.TypeLink, Linkname: "big"}, ""})
	}
	limits := ExtractLimits{Entries: 100, Bytes: 2 << 20, Depth: 8}
	if err := Extract(archive(t, entries...), t.TempDir(), limits); err != nil {
		t.Fatal(err)
	}
}
