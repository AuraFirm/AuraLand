package judge

import (
	"context"
	"errors"
	"testing"

	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

type fixedData map[string][2]string

func (d fixedData) Test(_ context.Context, id string) ([]byte, []byte, error) {
	pair, ok := d[id]
	if !ok {
		return nil, nil, errors.New("no such test")
	}
	return []byte(pair[0]), []byte(pair[1]), nil
}

func job(scoring string, checker string, ids ...string) wire.LeasedJob {
	tests := make([]wire.TestSpec, len(ids))
	for i, id := range ids {
		tests[i] = wire.TestSpec{ID: id, Group: "all", Points: 10}
	}
	return wire.LeasedJob{
		Submission: wire.Submission{Language: "cpp", Source: "x"},
		Task: wire.Task{Spec: wire.Spec{
			TimeLimitMS: 1000, MemoryLimitKiB: 262144, OutputLimitKiB: 1024,
			Scoring: wire.Scoring{Type: scoring}, Checker: wire.Checker{Type: checker}, Tests: tests,
		}},
	}
}

var data = fixedData{"1": {"in1", "in1"}, "2": {"in2", "in2"}, "3": {"in3", "in3"}}

func TestEveryTestPassesWhenOutputsMatch(t *testing.T) {
	box := &sandbox.Fake{}
	result, err := Run(context.Background(), box, data, job("binary", "exact", "1", "2", "3"))
	if err != nil || !result.CompileOK || len(result.Tests) != 3 {
		t.Fatalf("result %+v err %v", result, err)
	}
	for _, test := range result.Tests {
		if test.Verdict != "AC" {
			t.Fatalf("%s: %s", test.TestID, test.Verdict)
		}
	}
	if box.Compiles != 1 || box.Runs != 3 {
		t.Fatalf("compiles %d runs %d", box.Compiles, box.Runs)
	}
}

func TestBinaryTasksStopAtTheFirstFailure(t *testing.T) {
	box := &sandbox.Fake{RunFunc: func(stdin []byte) sandbox.RunResult {
		if string(stdin) == "in2" {
			return sandbox.RunResult{Verdict: "OK", Stdout: []byte("wrong")}
		}
		return sandbox.RunResult{Verdict: "OK", Stdout: stdin}
	}}
	result, _ := Run(context.Background(), box, data, job("binary", "exact", "1", "2", "3"))
	if len(result.Tests) != 2 || result.Tests[1].Verdict != "WA" {
		t.Fatalf("got %+v", result.Tests)
	}
	if box.Runs != 2 {
		t.Fatalf("ran %d tests, want 2", box.Runs)
	}
}

func TestOtherScoringRunsEveryTest(t *testing.T) {
	box := &sandbox.Fake{RunFunc: func(stdin []byte) sandbox.RunResult {
		return sandbox.RunResult{Verdict: "TLE", CPUMS: 1001}
	}}
	result, _ := Run(context.Background(), box, data, job("subtasks", "exact", "1", "2", "3"))
	if len(result.Tests) != 3 || result.Tests[2].Verdict != "TLE" {
		t.Fatalf("got %+v", result.Tests)
	}
}

func TestSandboxVerdictsMapToTestVerdicts(t *testing.T) {
	for _, verdict := range []string{"TLE", "MLE", "OLE", "RTE"} {
		box := &sandbox.Fake{RunFunc: func([]byte) sandbox.RunResult { return sandbox.RunResult{Verdict: verdict} }}
		result, err := Run(context.Background(), box, data, job("binary", "exact", "1"))
		if err != nil || result.Tests[0].Verdict != verdict {
			t.Fatalf("%s: %+v %v", verdict, result, err)
		}
	}
}

func TestACompileErrorIsReportedWithoutRunningAnything(t *testing.T) {
	box := &sandbox.Fake{CompileFunc: func(string, string) sandbox.CompileResult {
		return sandbox.CompileResult{OK: false, Message: "error: nope"}
	}}
	result, err := Run(context.Background(), box, data, job("binary", "exact", "1"))
	if err != nil || result.CompileOK || result.CompileMessage != "error: nope" || box.Runs != 0 {
		t.Fatalf("%+v %v runs=%d", result, err, box.Runs)
	}
}

func TestSystemFailuresAreErrorsNotVerdicts(t *testing.T) {
	box := &sandbox.Fake{RunFunc: func([]byte) sandbox.RunResult { return sandbox.RunResult{Verdict: "SE"} }}
	if _, err := Run(context.Background(), box, data, job("binary", "exact", "1")); err == nil {
		t.Fatal("a sandbox failure must not become a verdict")
	}
	if _, err := Run(context.Background(), &sandbox.Fake{}, fixedData{}, job("binary", "exact", "1")); err == nil {
		t.Fatal("missing test data must not become a verdict")
	}
}

func TestUnsupportedTasksAreRefusedBeforeCompiling(t *testing.T) {
	box := &sandbox.Fake{}
	if _, err := Run(context.Background(), box, data, job("binary", "custom", "1")); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("custom checker: %v", err)
	}
	interactive := job("binary", "exact", "1")
	interactive.Task.Spec.Interactive = true
	if _, err := Run(context.Background(), box, data, interactive); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("interactive: %v", err)
	}
	if box.Compiles != 0 {
		t.Fatal("nothing should compile for an unsupported task")
	}
}

func TestCompare(t *testing.T) {
	cases := []struct {
		checker, got, want string
		same               bool
	}{
		{"exact", "1 2 \n3\n\n", "1 2\n3", true},
		{"exact", "1  2", "1 2", false},
		{"exact", "a\r\nb", "a\nb", true},
		{"tokens", "1   2\n3", "1 2 3", true},
		{"tokens", "1 2", "1 2 3", false},
		{"float", "0.1000001 2", "0.1 2", true},
		{"float", "0.2 2", "0.1 2", false},
		{"float", "nan", "nan", true},
		{"float", "x", "y", false},
	}
	for _, c := range cases {
		got, known := Compare(c.checker, []byte(c.got), []byte(c.want))
		if !known || got != c.same {
			t.Errorf("%s %q vs %q: got %v want %v", c.checker, c.got, c.want, got, c.same)
		}
	}
	if _, known := Compare("custom", nil, nil); known {
		t.Error("custom checkers are not built in")
	}
}

// The bundle opener is a program of this node, not a language: a submission naming it must not run.
func TestTheOpenerIsNotASubmissionLanguage(t *testing.T) {
	box := &sandbox.Fake{}
	attempt := job("binary", "exact", "1")
	attempt.Submission.Language = sandbox.OpenerLanguage
	if _, err := Run(context.Background(), box, data, attempt); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("got %v", err)
	}
	if box.Compiles != 0 || box.Runs != 0 {
		t.Fatal("nothing may reach the sandbox")
	}
}
