package validate

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/AuraFirm/AuraLand/judge/internal/bundles"
	"github.com/AuraFirm/AuraLand/judge/internal/judge"
	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

// Goal: the node reports what every solution did on every test and decides nothing. Method: a sandbox
// whose "programs" are their source text, and a bundle stream built by hand.
type program struct{ source string }

func (program) Release() {}

type sourceBox struct{ compiles, runs int }

func (b *sourceBox) Compile(_ context.Context, _, source string, _ sandbox.Limits) (sandbox.CompileResult, error) {
	b.compiles++
	if strings.Contains(source, "BROKEN") {
		return sandbox.CompileResult{OK: false, Message: "error"}, nil
	}
	return sandbox.CompileResult{OK: true, Program: program{source}}, nil
}

func (b *sourceBox) Run(_ context.Context, p sandbox.Program, stdin []byte, _ sandbox.Limits) (sandbox.RunResult, error) {
	b.runs++
	switch source := p.(program).source; {
	case strings.Contains(source, "SLOW"):
		return sandbox.RunResult{Verdict: "TLE", CPUMS: 1000}, nil
	case strings.Contains(source, "WRONG") || strings.Contains(source, "echo -"):
		return sandbox.RunResult{Verdict: "OK", Stdout: []byte("nope"), CPUMS: 3}, nil
	case strings.Contains(source, "SYSTEM"):
		return sandbox.RunResult{Verdict: "SE"}, nil
	default:
		return sandbox.RunResult{Verdict: "OK", Stdout: stdin, CPUMS: 3}, nil
	}
}

func record(path, body string) string {
	digest := sha256.Sum256([]byte(body))
	return fmt.Sprintf("%d %x %s\n%s\n", len(body), digest, path, body)
}

type opener struct {
	stream string
	err    error
}

func (o opener) OpenFiles(context.Context, string, wire.Bundle) (*bundles.Files, error) {
	if o.err != nil {
		return nil, o.err
	}
	return bundles.ParseStream([]byte(o.stream))
}

func stream(records ...string) string {
	return "AURA-OPEN 1\n" + strings.Join(records, "") + fmt.Sprintf("END %d\n", len(records))
}

func job() wire.ValidationJob {
	return wire.ValidationJob{JobID: "job_1", Task: wire.Task{Spec: wire.Spec{
		TimeLimitMS: 1000, MemoryLimitKiB: 1, OutputLimitKiB: 1,
		Scoring: wire.Scoring{Type: "binary"}, Checker: wire.Checker{Type: "exact"},
		Tests: []wire.TestSpec{{ID: "1"}, {ID: "2"}},
	}}}
}

func goodStream(extra ...string) string {
	records := []string{
		record("solutions/reference.cpp", "echo"),
		record("tests/1.ans", "a"), record("tests/1.in", "a"),
		record("tests/2.ans", "b"), record("tests/2.in", "b"),
	}
	return stream(append(records, extra...)...)
}

func TestRunReportsEverySolutionOnEveryTest(t *testing.T) {
	box := &sourceBox{}
	input := goodStream(record("solutions/wrong_a.py", "WRONG"))
	result, err := (&Runner{Box: box, Open: opener{stream: strings.Replace(input, "END 6", "END 6", 1)}}).Run(context.Background(), job())
	if err != nil {
		t.Fatal(err)
	}
	if !result.Bundle.Opens || len(result.Runs) != 3 {
		t.Fatalf("%+v", result)
	}
	reference1, reference2, wrong := result.Runs[0], result.Runs[1], result.Runs[2]
	if reference1.Solution != "reference.cpp" || reference1.Repeat != 1 || reference2.Repeat != 2 || wrong.Solution != "wrong_a.py" {
		t.Fatalf("order or names: %+v", result.Runs)
	}
	for _, run := range []wire.ValidationRun{reference1, reference2} {
		if len(run.Tests) != 2 || run.Tests[0].Verdict != "AC" || run.Tests[1].Verdict != "AC" {
			t.Fatalf("reference should pass everything: %+v", run)
		}
	}
	// A binary task would stop at the first failure when judging; validation must see every test.
	if len(wrong.Tests) != 2 || wrong.Tests[0].Verdict != "WA" || wrong.Tests[1].Verdict != "WA" {
		t.Fatalf("a wrong solution is run on every test: %+v", wrong)
	}
	if box.compiles != 2 {
		t.Fatalf("each solution is compiled once, got %d", box.compiles)
	}
}

func TestRunReportsCompileFailureTimeoutAndRefusal(t *testing.T) {
	box := &sourceBox{}
	input := goodStream(record("solutions/wrong_b.cpp", "BROKEN"), record("solutions/wrong_c.cpp", "SLOW"))
	result, err := (&Runner{Box: box, Open: opener{stream: input}}).Run(context.Background(), job())
	if err != nil {
		t.Fatal(err)
	}
	broken, slow := result.Runs[2], result.Runs[3]
	if broken.CompileOK || len(broken.Tests) != 0 || broken.Tests == nil {
		t.Fatalf("a failed compile has an empty, non-nil test list: %+v", broken)
	}
	if slow.Tests[0].Verdict != "TLE" {
		t.Fatalf("%+v", slow)
	}
	refused, err := (&Runner{Box: box, Open: opener{err: &bundles.Refused{Code: "missing_file", Detail: "x"}}}).Run(context.Background(), job())
	if err != nil || refused.Bundle.Opens || refused.Bundle.Refusal != "missing_file" || refused.Runs == nil {
		t.Fatalf("a refusal is a result: %+v %v", refused, err)
	}
}

func TestRunTreatsNodeFailuresAsErrors(t *testing.T) {
	for name, runner := range map[string]*Runner{
		"download fails": {Box: &sourceBox{}, Open: opener{err: errors.New("network")}},
		"sandbox fails":  {Box: &sourceBox{}, Open: opener{stream: goodStream(record("solutions/wrong_a.py", "SYSTEM"))}},
	} {
		if _, err := runner.Run(context.Background(), job()); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	custom := job()
	custom.Task.Spec.Checker.Type = "custom"
	if _, err := (&Runner{Box: &sourceBox{}, Open: opener{stream: goodStream()}}).Run(context.Background(), custom); !errors.Is(err, judge.ErrUnsupported) {
		t.Fatalf("a custom checker is not supported here: %v", err)
	}
}

func TestMutantsAreKilledOrSurviveAndOnlyWhenTheReferencePasses(t *testing.T) {
	reference := func(source string) string {
		return stream(record("solutions/reference.cpp", source), record("tests/1.ans", "a"), record("tests/1.in", "a"), record("tests/2.ans", "b"), record("tests/2.in", "b"))
	}
	result, err := (&Runner{Box: &sourceBox{}, Open: opener{stream: reference("echo + 1")}}).Run(context.Background(), job())
	if err != nil {
		t.Fatal(err)
	}
	killed := map[string]bool{}
	for _, m := range result.Mutants {
		if !m.CompileOK || m.Line != 1 {
			t.Errorf("%+v", m)
		}
		killed[m.Operator] = m.Killed
	}
	if len(result.Mutants) != 2 || !killed["+ to -"] || killed["1 to 2"] {
		t.Fatalf("the swap is caught, the boundary change survives: %+v", result.Mutants)
	}
	broken, _ := (&Runner{Box: &sourceBox{}, Open: opener{stream: reference("echo + 1 WRONG")}}).Run(context.Background(), job())
	if len(broken.Mutants) != 0 || broken.Mutants == nil {
		t.Fatalf("a failing reference gives no mutants, and an empty list not null: %+v", broken.Mutants)
	}
}
