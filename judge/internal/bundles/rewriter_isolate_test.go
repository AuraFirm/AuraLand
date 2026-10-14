//go:build linux && isolate

package bundles

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/AuraFirm/AuraLand/judge/internal/isolate"
)

// The rewriter against the real sandbox, on a judge node or a Linux VM with isolate (4C slice 1):
//
//	AURA_ISOLATE_BIN=/usr/local/bin/isolate go test -tags isolate ./internal/bundles -run Rewriter
//
// It needs the pinned Node under /opt/aura/node and the built programs (node tools/build-opener.ts).
func realRewriter(t *testing.T) *Rewriter {
	binary := os.Getenv("AURA_ISOLATE_BIN")
	if binary == "" {
		t.Skip("AURA_ISOLATE_BIN is not set")
	}
	script, err := os.ReadFile("../../../packages/bundle/dist/rewrite-bundle.cjs")
	if err != nil {
		t.Fatal(err)
	}
	box, err := isolate.New(binary, 1)
	if err != nil {
		t.Fatal(err)
	}
	return &Rewriter{Box: box, Script: string(script)}
}

func TestRealRewriterWritesTheMarkAndTheResultOpens(t *testing.T) {
	rewriter := realRewriter(t)
	original := corpus(t, "golden-solved.tar.zst")
	rewritten, marks, err := rewriter.Rewrite(context.Background(), original, 0xc0ffee42)
	if err != nil {
		t.Fatal(err)
	}
	if marks.Answers || !marks.Solutions {
		t.Fatalf("golden-solved has an exact checker: only the solutions carry a mark, got %+v", marks)
	}
	if string(rewritten) == string(original) {
		t.Fatal("the rewritten bundle must differ from the original")
	}
	// The rewritten bytes open in a second box exactly like an original, with the mark in the solutions.
	opener, job := realOpener(t, rewritten)
	files, err := opener.OpenFiles(context.Background(), job.JobID, job.Task.Bundle)
	if err != nil {
		t.Fatal(err)
	}
	reference, _ := files.Get("solutions/reference.cpp")
	if want := "// aura-wm:c0ffee42\n"; string(reference[len(reference)-len(want):]) != want {
		t.Fatalf("reference does not end with the mark: %q", reference)
	}
	input, _ := files.Get("tests/002.in")
	if string(input) != "40 2\n" {
		t.Fatalf("test inputs must be untouched: %q", input)
	}
}

func TestRealRewriterRefusesWhatTheValidatorRefuses(t *testing.T) {
	rewriter := realRewriter(t)
	for name, code := range map[string]string{
		"ratio-bomb-300mib-of-zeros.tar.zst":    "compression_ratio",
		"tar-golden-with-symlink-first.tar.zst": "unsupported_entry",
		"layout-no-statement.tar.zst":           "missing_file",
	} {
		_, _, err := rewriter.Rewrite(context.Background(), corpus(t, name), 0xc0ffee42)
		var refused *Refused
		if !errors.As(err, &refused) || refused.Code != code {
			t.Errorf("%s: got %v want refusal %s", name, err, code)
		}
	}
}
