package isolate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// This part runs everywhere: the escape programs exist, each states what it expects, and each is one of
// the kinds the suite knows how to judge. The suite itself (escape_test.go) needs Linux and isolate.
func TestEveryEscapeProgramStatesItsExpectation(t *testing.T) {
	files, err := filepath.Glob("../../testdata/escape/*.cpp")
	if err != nil || len(files) < 14 {
		t.Fatalf("expected at least 14 escape programs, found %d (%v)", len(files), err)
	}
	for _, file := range files {
		source, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		first, _, _ := strings.Cut(string(source), "\n")
		if !strings.HasPrefix(first, "// Expected:") {
			t.Errorf("%s: the first line must say what is expected", filepath.Base(file))
		}
	}
}
