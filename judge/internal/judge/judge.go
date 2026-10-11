// Package judge runs one leased submission: compile, run each test in order, compare, and build the
// result the control plane expects. It decides test verdicts only; the overall verdict and score are
// decided by the control plane from the spec (modules/submissions/rules.ts).
package judge

import (
	"context"
	"errors"
	"fmt"

	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

// TestData is where a test's input and jury answer come from: the unpacked, verified bundle.
type TestData interface {
	Test(ctx context.Context, id string) (input, answer []byte, err error)
}

// ErrUnsupported means this node cannot judge the job (for example a custom checker); the job goes
// back to the queue for a node that can.
var ErrUnsupported = errors.New("this node cannot judge that task")

// Run judges the job. Errors are system errors: the node (not the participant) failed.
func Run(ctx context.Context, box sandbox.Sandbox, data TestData, job wire.LeasedJob) (wire.Result, error) {
	spec := job.Task.Spec
	if spec.Checker.Type == "custom" || spec.Interactive {
		return wire.Result{}, ErrUnsupported
	}
	compileLimits := sandbox.Limits{CPUMS: 10_000, WallMS: 30_000, MemoryKiB: 512 * 1024, OutputKiB: 64}
	compiled, err := box.Compile(ctx, job.Submission.Language, job.Submission.Source, compileLimits)
	if err != nil {
		return wire.Result{}, fmt.Errorf("compile: %w", err)
	}
	if !compiled.OK {
		return wire.Result{CompileOK: false, CompileMessage: compiled.Message, Tests: []wire.TestResult{}}, nil
	}
	defer compiled.Program.Release()

	limits := sandbox.Limits{
		CPUMS:     spec.TimeLimitMS,
		WallMS:    spec.TimeLimitMS * 3,
		MemoryKiB: spec.MemoryLimitKiB,
		OutputKiB: spec.OutputLimitKiB,
	}
	results := make([]wire.TestResult, 0, len(spec.Tests))
	for _, test := range spec.Tests {
		result, err := runTest(ctx, box, data, compiled.Program, spec, test, limits)
		if err != nil {
			return wire.Result{}, err
		}
		results = append(results, result)
		// Binary tasks stop at the first failure; every other kind needs all tests.
		if spec.Scoring.Type == "binary" && result.Verdict != "AC" {
			break
		}
	}
	return wire.Result{CompileOK: true, Tests: results}, nil
}

func runTest(ctx context.Context, box sandbox.Sandbox, data TestData, program sandbox.Program, spec wire.Spec, test wire.TestSpec, limits sandbox.Limits) (wire.TestResult, error) {
	input, answer, err := data.Test(ctx, test.ID)
	if err != nil {
		return wire.TestResult{}, fmt.Errorf("test %s: %w", test.ID, err)
	}
	run, err := box.Run(ctx, program, input, limits)
	if err != nil {
		return wire.TestResult{}, fmt.Errorf("run %s: %w", test.ID, err)
	}
	result := wire.TestResult{TestID: test.ID, CPUMS: run.CPUMS, WallMS: run.WallMS, MemoryKiB: run.MemoryKiB}
	switch run.Verdict {
	case "OK":
		same, known := Compare(spec.Checker.Type, run.Stdout, answer)
		if !known {
			return wire.TestResult{}, ErrUnsupported
		}
		result.Verdict = "WA"
		if same {
			result.Verdict = "AC"
		}
	case "TLE", "MLE", "OLE", "RTE":
		result.Verdict = run.Verdict
	default:
		// "SE" or anything unknown: the sandbox failed, which says nothing about the code.
		return wire.TestResult{}, fmt.Errorf("sandbox failure on test %s (%s)", test.ID, run.Verdict)
	}
	return result, nil
}
