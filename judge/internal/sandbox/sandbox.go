// Package sandbox is the only way the agent runs untrusted code. Everything that executes a
// submission goes through the Sandbox interface; the interface has no way to start a process on the
// host. Implementations: Fake (tests) and, on Linux judge nodes, an isolate-based one.
package sandbox

import "context"

// OpenerLanguage names the profile that opens task bundles. It is an internal program, never a language
// a submission may use; the judge refuses it as a submission language.
const OpenerLanguage = "bundle-opener"

// RewriterLanguage names the profile that writes a delivery's watermark into a bundle, in the same way.
const RewriterLanguage = "bundle-rewriter"

// Limits are the resources one run may use. A zero value is never valid.
type Limits struct {
	CPUMS     int
	WallMS    int
	MemoryKiB int
	OutputKiB int
}

type CompileResult struct {
	OK      bool
	Message string // compiler output, bounded and with control characters removed by the implementation
	// Program is an opaque handle to the compiled program inside the sandbox.
	Program Program
}

type Program interface {
	// Release discards the compiled artifacts.
	Release()
}

type RunResult struct {
	// Verdict is the sandbox's own view of the run: "OK" (exited normally), "TLE", "MLE", "OLE", "RTE"
	// or "SE" (the sandbox itself failed). Correctness of the output is decided elsewhere.
	Verdict   string
	CPUMS     int
	WallMS    int
	MemoryKiB int
	Stdout    []byte
	// ExitCode and Signaled say how the program ended; the escape suite needs them, verdicts do not.
	ExitCode int
	Signaled bool
}

type Sandbox interface {
	Compile(ctx context.Context, language, source string, limits Limits) (CompileResult, error)
	Run(ctx context.Context, program Program, stdin []byte, limits Limits) (RunResult, error)
}
