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
	result := runReal(t, "golden-solved.tar.zst", [2]bool{true, false})
	checkSolutions(t, result)
	// Only the first test is a sample, so looking samples up gets through one test and no further. This
	// task IS "sum the integers", so the generic sum attacker legitimately solves all of it: the harness
	// is right to flag a task that a program ignorant of the statement can solve.
	for _, attacker := range result.Attackers {
		want := 0
		switch attacker.Name {
		case "sample_lookup":
			want = 1
		case "sum_of_integers":
			want = 2
		}
		if attacker.Passed != want || attacker.Total != 2 {
			t.Errorf("attacker %s: passed %d of %d, want %d of 2", attacker.Name, attacker.Passed, attacker.Total, want)
		}
	}
}

// When every test is a public sample, the lookup attacker passes the whole task: the weak case.
func TestRealSandboxFlagsATaskThatOnlyChecksSamples(t *testing.T) {
	result := runReal(t, "golden-weak-samples.tar.zst", [2]bool{true, true})
	beaten := []string{}
	for _, attacker := range result.Attackers {
		if attacker.Passed == attacker.Total {
			beaten = append(beaten, attacker.Name)
		}
	}
	if len(beaten) != 2 || beaten[0] != "sample_lookup" || beaten[1] != "sum_of_integers" {
		t.Fatalf("the sample lookup (all tests public) and the sum attacker (the task is a sum) should win, got %v", beaten)
	}
}

func runReal(t *testing.T, corpusFile string, samples [2]bool) wire.ValidationResult {
	binary := os.Getenv("AURA_ISOLATE_BIN")
	if binary == "" {
		t.Skip("AURA_ISOLATE_BIN is not set")
	}
	script, err := os.ReadFile("../../../packages/bundle/dist/open-bundle.cjs")
	if err != nil {
		t.Fatal(err)
	}
	packed, err := os.ReadFile("../../../packages/bundle/corpus/" + corpusFile)
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
		Tests: []wire.TestSpec{{ID: "001", IsSample: samples[0]}, {ID: "002", IsSample: samples[1]}},
	}}}
	result, err := (&Runner{Box: box, Open: opener}).Run(context.Background(), job)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func checkSolutions(t *testing.T, result wire.ValidationResult) {
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
