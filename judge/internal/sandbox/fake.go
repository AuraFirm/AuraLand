package sandbox

import "context"

// Fake is a Sandbox for tests: it runs nothing, it answers from functions the test supplies.
type Fake struct {
	CompileFunc func(language, source string) CompileResult
	RunFunc     func(stdin []byte) RunResult
	Compiles    int
	Runs        int
}

type fakeProgram struct{}

func (fakeProgram) Release() {}

func (f *Fake) Compile(_ context.Context, language, source string, _ Limits) (CompileResult, error) {
	f.Compiles++
	if f.CompileFunc == nil {
		return CompileResult{OK: true, Program: fakeProgram{}}, nil
	}
	result := f.CompileFunc(language, source)
	if result.OK && result.Program == nil {
		result.Program = fakeProgram{}
	}
	return result, nil
}

func (f *Fake) Run(_ context.Context, _ Program, stdin []byte, _ Limits) (RunResult, error) {
	f.Runs++
	if f.RunFunc == nil {
		return RunResult{Verdict: "OK", CPUMS: 5, WallMS: 6, MemoryKiB: 1000, Stdout: stdin}, nil
	}
	return f.RunFunc(stdin), nil
}
