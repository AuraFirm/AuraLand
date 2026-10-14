//go:build linux && isolate

package validate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"testing"

	"github.com/AuraFirm/AuraLand/judge/internal/bundles"
	"github.com/AuraFirm/AuraLand/judge/internal/isolate"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

// The validation runner against the real sandbox (cutlist F30, F31), on a judge node or a Linux VM:
//
//	AURA_ISOLATE_BIN=/usr/local/bin/isolate go test -tags isolate ./internal/validate -v
//
// It needs g++, python3, the pinned Node under /opt/aura/node and the built opener. The bundle is the
// corpus's golden-solved: a correct C++ reference and four wrong solutions that fail differently.
func TestRealSandboxObservesEverySolution(t *testing.T) {
	binary := os.Getenv("AURA_ISOLATE_BIN")
	if binary == "" {
		t.Skip("AURA_ISOLATE_BIN is not set")
	}
	script, err := os.ReadFile("../../../packages/bundle/dist/open-bundle.cjs")
	if err != nil {
		t.Fatal(err)
	}
	packed, err := os.ReadFile("../../../packages/bundle/corpus/golden-solved.tar.zst")
	if err != nil {
		t.Fatal(err)
	}
	box, err := isolate.New(binary, 1)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(packed)
	bundle := wire.Bundle{SHA256: hex.EncodeToString(digest[:]), Bytes: int64(len(packed))}
	opener := &bundles.Opener{Box: box, Script: string(script),
		Fetch: func(context.Context, string, wire.Bundle) ([]byte, error) { return packed, nil }}
	job := wire.ValidationJob{JobID: "job_real", Task: wire.Task{Bundle: bundle, Spec: wire.Spec{
		TimeLimitMS: 1000, MemoryLimitKiB: 262144, OutputLimitKiB: 1024,
		Scoring: wire.Scoring{Type: "binary"}, Checker: wire.Checker{Type: "exact"},
		Tests: []wire.TestSpec{{ID: "001"}, {ID: "002"}},
	}}}
	result, err := (&Runner{Box: box, Open: opener}).Run(context.Background(), job)
	if err != nil {
		t.Fatal(err)
	}
	type key struct {
		solution string
		repeat   int
	}
	want := map[key][]string{
		{"reference.cpp", 1}:          {"AC", "AC"},
		{"reference.cpp", 2}:          {"AC", "AC"},
		{"wrong_loops.cpp", 1}:        {"TLE", "TLE"},
		{"wrong_noncompiling.cpp", 1}: nil,
		{"wrong_off_by_one.cpp", 1}:   {"WA", "WA"},
		{"wrong_python.py", 1}:        {"WA", "WA"},
	}
	if len(result.Mutants) != 1 || result.Mutants[0].Operator != "+ to -" || !result.Mutants[0].CompileOK || !result.Mutants[0].Killed {
		t.Errorf("the only change to the sum program is + to -, and the tests catch it: %+v", result.Mutants)
	}
	if !result.Bundle.Opens || len(result.Runs) != len(want) {
		t.Fatalf("%+v", result)
	}
	for _, run := range result.Runs {
		expected, known := want[key{run.Solution, run.Repeat}]
		if !known {
			t.Errorf("unexpected run %s #%d", run.Solution, run.Repeat)
			continue
		}
		if run.CompileOK != (expected != nil) || len(run.Tests) != len(expected) {
			t.Errorf("%s #%d: compile %v tests %d", run.Solution, run.Repeat, run.CompileOK, len(run.Tests))
			continue
		}
		for i, test := range run.Tests {
			if test.Verdict != expected[i] {
				t.Errorf("%s #%d test %s: got %s want %s", run.Solution, run.Repeat, test.TestID, test.Verdict, expected[i])
			}
		}
		t.Logf("%s #%d compile=%v %v", run.Solution, run.Repeat, run.CompileOK, run.Tests)
	}
}
