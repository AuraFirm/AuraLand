package tier2

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// A Trace is the record of one environment run (Stage 8 slice 7): which steps ran, how each ended, what the workspace was
// after each, the integrity flags and the verifier's judgement. It holds hashes of what was printed, not the printed text
// (which is untrusted and may be large), and nothing in it is a secret. The node signs it; the control plane stores and
// checks it. Fields are plain structs and slices (never maps), so the canonical bytes are the same on every run.
const (
	TraceVersion  = 1
	traceStepsMax = 200
	traceBytesMax = 8 << 20 // ENV_TRACE_BYTES_MAX in the contracts
)

type TraceStep struct {
	Name         string   `json:"name"`
	Argv         []string `json:"argv"`
	Verdict      string   `json:"verdict"`
	ExitCode     int      `json:"exit_code"`
	WallMS       int      `json:"wall_ms"`
	PeakMemoryMB int      `json:"peak_memory_mib"`
	PidsPeak     int      `json:"pids_peak"`
	StdoutBytes  int      `json:"stdout_bytes"`
	StdoutSHA256 string   `json:"stdout_sha256"`
	TreeHash     string   `json:"tree_hash"`
}

type TraceFlag struct {
	Kind        string `json:"kind"`
	Subject     string `json:"subject"`
	Explanation string `json:"explanation"`
}

type TraceVerifier struct {
	Score   float64  `json:"score"`
	Detail  string   `json:"detail"`
	Dropped []string `json:"dropped"`
}

type Trace struct {
	Version   int            `json:"version"`
	Isolation string         `json:"isolation"`
	Outcome   string         `json:"outcome"`
	StartHash string         `json:"start_hash"`
	Steps     []TraceStep    `json:"steps"`
	Flags     []TraceFlag    `json:"flags"`
	Verifier  *TraceVerifier `json:"verifier"`
}

// BuildTrace assembles a trace from a finished session, its flags and (when it ran) the verifier's result.
func BuildTrace(session SessionResult, flags []Flag, verifier *VerifierResult) (Trace, error) {
	if len(session.Steps) > traceStepsMax {
		return Trace{}, fmt.Errorf("trace: more than %d steps", traceStepsMax)
	}
	t := Trace{Version: TraceVersion, Isolation: session.Isolation, Outcome: session.Outcome, StartHash: session.StartHash, Steps: []TraceStep{}, Flags: []TraceFlag{}}
	for _, s := range session.Steps {
		sum := sha256.Sum256(s.Result.Stdout)
		t.Steps = append(t.Steps, TraceStep{
			Name: s.Name, Argv: s.Argv, Verdict: s.Result.Verdict, ExitCode: s.Result.ExitCode, WallMS: s.Result.WallMS,
			PeakMemoryMB: s.Result.PeakMemoryMiB, PidsPeak: s.Result.PidsPeak, StdoutBytes: len(s.Result.Stdout),
			StdoutSHA256: hex.EncodeToString(sum[:]), TreeHash: s.TreeHash,
		})
	}
	for _, f := range flags {
		t.Flags = append(t.Flags, TraceFlag{f.Kind, f.Subject, f.Explanation})
	}
	if verifier != nil {
		dropped := verifier.Snapshot.Dropped
		if dropped == nil {
			dropped = []string{}
		}
		t.Verifier = &TraceVerifier{Score: verifier.Score, Detail: verifier.Detail, Dropped: dropped}
	}
	if _, err := t.Canonical(); err != nil {
		return Trace{}, err
	}
	return t, nil
}

// Canonical is the byte string that is signed and stored. It refuses a trace over the size cap.
func (t Trace) Canonical() ([]byte, error) {
	raw, err := json.Marshal(t)
	if err != nil {
		return nil, err
	}
	if len(raw) > traceBytesMax {
		return nil, fmt.Errorf("trace: %d bytes is over the %d byte cap", len(raw), traceBytesMax)
	}
	return raw, nil
}

// ReplayReport compares a fresh run of the same session with a trace.
type ReplayReport struct {
	Equal       bool
	Differences []string
}

// Replay runs the session again from a pristine copy of the starting workspace and compares every step with the trace: same
// verdict and exit status, same output, same workspace afterwards. "Deterministic" is a claim about an environment only when
// this reports Equal; an environment whose steps depend on the time or on randomness will not.
func Replay(ctx context.Context, rt Runtime, spec SessionSpec, original Trace, pristine string) (ReplayReport, error) {
	work, err := os.MkdirTemp("", "replay-")
	if err != nil {
		return ReplayReport{}, err
	}
	defer os.RemoveAll(work)
	workspace := filepath.Join(work, "ws")
	if _, err := Snapshot(pristine, workspace, int64(spec.Limits.DiskMiB)<<20); err != nil {
		return ReplayReport{}, err
	}
	spec.Workspace = workspace
	run, err := spec.Run(ctx, rt)
	if err != nil {
		return ReplayReport{}, err
	}
	again, err := BuildTrace(run, nil, nil)
	if err != nil {
		return ReplayReport{}, err
	}
	return compare(original, again), nil
}

func compare(a, b Trace) ReplayReport {
	var diff []string
	if a.StartHash != b.StartHash {
		diff = append(diff, "the starting workspace differs")
	}
	if a.Outcome != b.Outcome {
		diff = append(diff, fmt.Sprintf("outcome %s vs %s", a.Outcome, b.Outcome))
	}
	if len(a.Steps) != len(b.Steps) {
		diff = append(diff, fmt.Sprintf("%d steps vs %d", len(a.Steps), len(b.Steps)))
	}
	for i := 0; i < len(a.Steps) && i < len(b.Steps); i++ {
		x, y := a.Steps[i], b.Steps[i]
		switch {
		case x.Verdict != y.Verdict || x.ExitCode != y.ExitCode:
			diff = append(diff, fmt.Sprintf("step %s: ended %s/%d vs %s/%d", x.Name, x.Verdict, x.ExitCode, y.Verdict, y.ExitCode))
		case x.StdoutSHA256 != y.StdoutSHA256:
			diff = append(diff, fmt.Sprintf("step %s: its output differs", x.Name))
		case x.TreeHash != y.TreeHash:
			diff = append(diff, fmt.Sprintf("step %s: the workspace afterwards differs", x.Name))
		}
	}
	return ReplayReport{Equal: len(diff) == 0, Differences: diff}
}
