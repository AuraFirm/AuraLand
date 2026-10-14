package bundles

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/AuraFirm/AuraLand/judge/internal/sandbox"
)

// RewriteLimits bound the box that rewrites a bundle: it reads the packed bundle (at most 64 MiB), unpacks
// and rebuilds it (up to 256 MiB unpacked) and writes the packed result, so memory, time and output are
// those of the opener plus the compression.
var RewriteLimits = sandbox.Limits{CPUMS: 120_000, WallMS: 240_000, MemoryKiB: 2 * 1024 * 1024, OutputKiB: 65 * 1024}

// RewrittenBundleBytesMax is the largest packed result accepted (the bundle cap).
const RewrittenBundleBytesMax = 64 << 20

// Rewriter writes a delivery's tag into a bundle, inside a box (packages/bundle/src/rewrite.ts).
type Rewriter struct {
	Box sandbox.Sandbox
	// Script is the rewriter program (packages/bundle/dist/rewrite-bundle.cjs), read once at start-up.
	Script string
}

// Marks says which carriers took the tag.
type Marks struct{ Answers, Solutions bool }

// Rewrite returns the packed bundle with the tag in it. The tag must have its top bit set (the control
// plane derives it so). A bundle the validator refuses comes back as *Refused; any other failure is the
// node's.
func (r *Rewriter) Rewrite(ctx context.Context, packed []byte, tag uint32) ([]byte, Marks, error) {
	if tag&0x80000000 == 0 {
		return nil, Marks{}, errors.New("a tag has its top bit set")
	}
	compiled, err := r.Box.Compile(ctx, sandbox.RewriterLanguage, r.Script, RewriteLimits)
	if err != nil || !compiled.OK {
		return nil, Marks{}, fmt.Errorf("prepare rewriter: %v %s", err, compiled.Message)
	}
	defer compiled.Program.Release()
	request := append([]byte(fmt.Sprintf("AURA-REWRITE 1 %d\n", tag)), packed...)
	run, err := r.Box.Run(ctx, compiled.Program, request, RewriteLimits)
	if err != nil {
		return nil, Marks{}, fmt.Errorf("run rewriter: %w", err)
	}
	if run.Verdict != "OK" || run.ExitCode != 0 {
		return nil, Marks{}, fmt.Errorf("rewriter ended with %s, exit %d", run.Verdict, run.ExitCode)
	}
	return ParseRewritten(run.Stdout)
}

// ParseRewritten reads the rewriter's output: a header line, then the packed bundle.
func ParseRewritten(output []byte) ([]byte, Marks, error) {
	end := bytes.IndexByte(output, '\n')
	if end < 0 || end > 512 {
		return nil, Marks{}, errors.New("rewriter output has no header line")
	}
	header, body := string(output[:end]), output[end+1:]
	if refusal, isRefusal := strings.CutPrefix(header, "REFUSED "); isRefusal {
		if len(body) != 0 {
			return nil, Marks{}, errors.New("rewriter output continues after a refusal")
		}
		code, detail, _ := strings.Cut(refusal, " ")
		return nil, Marks{}, &Refused{Code: code, Detail: detail}
	}
	var answers, solutions int
	if _, err := fmt.Sscanf(header, "AURA-REWRITTEN %d %d", &answers, &solutions); err != nil || (answers|solutions) > 1 || answers < 0 || solutions < 0 {
		return nil, Marks{}, errors.New("rewriter output has an unknown header")
	}
	if len(body) == 0 || len(body) > RewrittenBundleBytesMax {
		return nil, Marks{}, errors.New("rewriter output has an empty or oversized bundle")
	}
	return body, Marks{Answers: answers == 1, Solutions: solutions == 1}, nil
}
