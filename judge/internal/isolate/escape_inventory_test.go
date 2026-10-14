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
	for _, suite := range inventorySuites {
		files, err := filepath.Glob("../../testdata/" + suite.directory + "/*" + suite.extension)
		if err != nil || len(files) < 14 {
			t.Fatalf("%s: expected at least 14 escape programs, found %d (%v)", suite.language, len(files), err)
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
}

// The same list as the suite's, without its build tags, so this check runs everywhere. Every language that
// has a profile a participant can pick must be here, with the same set of attacks as C++ has.
var inventorySuites = []struct{ language, directory, extension string }{
	{"cpp", "escape", ".cpp"},
	{"c", "escape-c", ".c"},
}

func TestEveryLanguageHasTheSameAttacksAsCpp(t *testing.T) {
	names := func(directory, extension string) []string {
		files, _ := filepath.Glob("../../testdata/" + directory + "/*" + extension)
		out := make([]string, 0, len(files))
		for _, file := range files {
			out = append(out, strings.TrimSuffix(filepath.Base(file), extension))
		}
		return out
	}
	reference := names("escape", ".cpp")
	for _, suite := range inventorySuites[1:] {
		got := names(suite.directory, suite.extension)
		if strings.Join(got, ",") != strings.Join(reference, ",") {
			t.Errorf("%s has attacks %v, C++ has %v", suite.language, got, reference)
		}
	}
}
