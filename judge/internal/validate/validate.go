// Package validate runs a task bundle's own solutions and reports what happened, nothing more. The
// reference must pass and the wrong solutions must fail, but whether they do is decided by the control
// plane from these observations (apps/api/src/modules/validation/rules.ts), never here: a node that
// could say "this task is fine" could be made to lie about it.
package validate

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/AuraFirm/AuraLand/judge/internal/bundles"
	"github.com/AuraFirm/AuraLand/judge/internal/judge"
	"github.com/AuraFirm/AuraLand/judge/internal/mutate"
	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

// Opener opens a job's bundle; *bundles.Opener implements it.
type Opener interface {
	OpenFiles(ctx context.Context, jobID string, bundle wire.Bundle) (*bundles.Files, error)
}

type Runner struct {
	Box  sandbox.Sandbox
	Open Opener
}

// Run opens the bundle and runs every solution on every test. A bundle the validator refuses is a
// result, not an error (the task is bad, the node is fine); any failure of the node itself is an error.
func (r *Runner) Run(ctx context.Context, job wire.ValidationJob) (wire.ValidationResult, error) {
	spec := job.Task.Spec
	if spec.Checker.Type == "custom" || spec.Interactive {
		return wire.ValidationResult{}, judge.ErrUnsupported
	}
	files, err := r.Open.OpenFiles(ctx, job.JobID, job.Task.Bundle)
	var refused *bundles.Refused
	if errors.As(err, &refused) {
		return wire.ValidationResult{Bundle: wire.ValidationBundle{Opens: false, Refusal: refused.Code}, Runs: []wire.ValidationRun{}, Mutants: []wire.ValidationMutant{}}, nil
	}
	if err != nil {
		return wire.ValidationResult{}, fmt.Errorf("open bundle: %w", err)
	}
	result := wire.ValidationResult{Bundle: wire.ValidationBundle{Opens: true}, Runs: []wire.ValidationRun{}, Mutants: []wire.ValidationMutant{}}
	for _, path := range files.Paths() {
		if !strings.HasPrefix(path, "solutions/") {
			continue
		}
		runs, err := r.runSolution(ctx, files, spec, path)
		if err != nil {
			return wire.ValidationResult{}, fmt.Errorf("%s: %w", path, err)
		}
		result.Runs = append(result.Runs, runs...)
	}
	mutants, err := r.mutate(ctx, files, spec, result.Runs)
	if err != nil {
		return wire.ValidationResult{}, fmt.Errorf("mutation: %w", err)
	}
	result.Mutants = mutants
	return result, nil
}

// mutate changes the reference one place at a time and sees whether any test fails. It only makes sense
// when the reference itself passes every test: otherwise a failing mutant proves nothing.
func (r *Runner) mutate(ctx context.Context, files *bundles.Files, spec wire.Spec, runs []wire.ValidationRun) ([]wire.ValidationMutant, error) {
	mutants := []wire.ValidationMutant{}
	name, ok := passingReference(runs)
	if !ok {
		return mutants, nil
	}
	language, err := languageOf(name)
	if err != nil {
		return nil, err
	}
	source, _ := files.Get("solutions/" + name)
	changes, err := mutate.Generate(language, string(source), mutate.MaxPerSolution)
	if err != nil {
		return nil, err
	}
	for _, change := range changes {
		observed, err := r.tryMutant(ctx, files, spec, language, change)
		if err != nil {
			return nil, fmt.Errorf("line %d (%s): %w", change.Line, change.Operator, err)
		}
		mutants = append(mutants, observed)
	}
	return mutants, nil
}

func passingReference(runs []wire.ValidationRun) (string, bool) {
	for _, run := range runs {
		if run.Repeat != 1 || !strings.HasPrefix(run.Solution, "reference.") || !run.CompileOK {
			continue
		}
		for _, test := range run.Tests {
			if test.Verdict != "AC" {
				return "", false
			}
		}
		return run.Solution, true
	}
	return "", false
}

func (r *Runner) tryMutant(ctx context.Context, files *bundles.Files, spec wire.Spec, language string, change mutate.Mutant) (wire.ValidationMutant, error) {
	observed := wire.ValidationMutant{Operator: change.Operator, Line: change.Line}
	compiled, err := r.Box.Compile(ctx, language, change.Source, judge.CompileLimits)
	if err != nil {
		return observed, fmt.Errorf("compile: %w", err)
	}
	if !compiled.OK {
		return observed, nil
	}
	defer compiled.Program.Release()
	observed.CompileOK = true
	// The first failing test is enough to kill it, and stopping there bounds the time a looping mutant costs.
	results, err := judge.RunTests(ctx, r.Box, files.TestData(), compiled.Program, spec, true)
	if err != nil {
		return observed, err
	}
	for _, result := range results {
		if result.Verdict != "AC" {
			observed.Killed = true
		}
	}
	return observed, nil
}

func languageOf(name string) (string, error) {
	switch {
	case strings.HasSuffix(name, ".cpp"):
		return "cpp", nil
	case strings.HasSuffix(name, ".py"):
		return "python3", nil
	}
	return "", fmt.Errorf("no language for %q", name)
}

// A solution is compiled once. The reference is then run twice, so the control plane can see whether
// the same program gives the same verdicts twice; every other solution runs once.
func (r *Runner) runSolution(ctx context.Context, files *bundles.Files, spec wire.Spec, path string) ([]wire.ValidationRun, error) {
	name := strings.TrimPrefix(path, "solutions/")
	language, err := languageOf(name)
	if err != nil {
		return nil, err
	}
	source, _ := files.Get(path)
	compiled, err := r.Box.Compile(ctx, language, string(source), judge.CompileLimits)
	if err != nil {
		return nil, fmt.Errorf("compile: %w", err)
	}
	if !compiled.OK {
		return []wire.ValidationRun{{Solution: name, Repeat: 1, CompileOK: false, Tests: []wire.ValidationTest{}}}, nil
	}
	defer compiled.Program.Release()
	repeats := 1
	if strings.HasPrefix(name, "reference.") {
		repeats = 2
	}
	runs := make([]wire.ValidationRun, 0, repeats)
	for repeat := 1; repeat <= repeats; repeat++ {
		results, err := judge.RunTests(ctx, r.Box, files.TestData(), compiled.Program, spec, false)
		if err != nil {
			return nil, err
		}
		tests := make([]wire.ValidationTest, 0, len(results))
		for _, result := range results {
			tests = append(tests, wire.ValidationTest{TestID: result.TestID, Verdict: result.Verdict, CPUMS: result.CPUMS})
		}
		runs = append(runs, wire.ValidationRun{Solution: name, Repeat: repeat, CompileOK: true, Tests: tests})
	}
	return runs, nil
}
