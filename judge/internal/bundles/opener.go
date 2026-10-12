package bundles

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/AuraFirm/AuraLand/judge/internal/judge"
	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
	"github.com/AuraFirm/AuraLand/judge/internal/wire"
)

// OpenLimits bound the box that opens a bundle. The output is the tests and solutions of one task
// (at most 256 MiB unpacked, plus record headers); memory covers the packed bytes, the unpacked tar and
// the copies the opener makes of it. Time is generous because unpacking 256 MiB of zstd is not instant.
var OpenLimits = sandbox.Limits{CPUMS: 60_000, WallMS: 120_000, MemoryKiB: 2 * 1024 * 1024, OutputKiB: 260 * 1024}

// Opener implements agent.Bundles.
type Opener struct {
	Box sandbox.Sandbox
	// Fetch returns the packed bundle bytes of the job's task. It is not trusted: Open checks them.
	Fetch func(ctx context.Context, job wire.LeasedJob) ([]byte, error)
	// Script is the opener program (packages/bundle/dist/open-bundle.cjs), read once at start-up.
	Script string
}

// Open downloads, verifies and opens the bundle of a job. The release function drops the contents.
func (o *Opener) Open(ctx context.Context, job wire.LeasedJob) (judge.TestData, func(), error) {
	files, err := o.OpenFiles(ctx, job)
	if err != nil {
		return nil, nil, err
	}
	return testData{files: files}, func() { files.byPath = nil }, nil
}

// OpenFiles is Open for callers (validation) that need the solutions too.
func (o *Opener) OpenFiles(ctx context.Context, job wire.LeasedJob) (*Files, error) {
	packed, err := o.Fetch(ctx, job)
	if err != nil {
		return nil, fmt.Errorf("download bundle: %w", err)
	}
	if err := CheckPacked(packed, job.Task.Bundle); err != nil {
		return nil, err
	}
	compiled, err := o.Box.Compile(ctx, sandbox.OpenerLanguage, o.Script, OpenLimits)
	if err != nil || !compiled.OK {
		return nil, fmt.Errorf("prepare opener: %v %s", err, compiled.Message)
	}
	defer compiled.Program.Release()
	run, err := o.Box.Run(ctx, compiled.Program, packed, OpenLimits)
	if err != nil {
		return nil, fmt.Errorf("run opener: %w", err)
	}
	if run.Verdict != "OK" || run.ExitCode != 0 {
		// The box failed (time, memory, crash): the node's fault, never a verdict on the task.
		return nil, fmt.Errorf("opener ended with %s, exit %d", run.Verdict, run.ExitCode)
	}
	return ParseStream(run.Stdout)
}

// CheckPacked is the first check on a download: exact size and SHA-256 of what the control plane named.
func CheckPacked(packed []byte, want wire.Bundle) error {
	if int64(len(packed)) != want.Bytes {
		return errors.New("bundle size differs from the job's")
	}
	digest := sha256.Sum256(packed)
	if hex.EncodeToString(digest[:]) != want.SHA256 {
		return errors.New("bundle SHA-256 differs from the job's")
	}
	return nil
}

type testData struct{ files *Files }

func (t testData) Test(_ context.Context, id string) ([]byte, []byte, error) {
	input, haveInput := t.files.Get("tests/" + id + ".in")
	answer, haveAnswer := t.files.Get("tests/" + id + ".ans")
	if !haveInput || !haveAnswer {
		return nil, nil, fmt.Errorf("test %q is not in the bundle", id)
	}
	return input, answer, nil
}
