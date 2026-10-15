package tier2

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

// VerifierSpec is the second sandbox of an environment run (ADR 0034 decision 4). It receives a SNAPSHOT of the
// workspace the agent left (see Snapshot) and the hidden material mounted read-only at /verifier, in a fresh sandbox the
// agent never ran in. The hidden material is never in the agent's image or mounts; the only way it meets the agent's output
// is here, after the agent has finished.
type VerifierSpec struct {
	Rootfs string // the verifier's image; may differ from the agent's
	Hidden string // host directory of hidden checks and answers, mounted read-only at /verifier
	Argv   []string
	Env    []string // includes the per-run canary values; the caller generates them
	UID    int
	GID    int
	Limits Limits
	// Protected paths (relative to the workspace) are put back from Pristine, the workspace as it was before the agent ran,
	// before the verifier looks: a check the agent edited is the recipe's check again, whatever the agent did to it. The
	// change is still reported by Detect; restoring only removes the reward.
	Pristine string
	Restore  []string
}

// VerifierResult is the verifier's judgement of the workspace, read from the last line it printed.
type VerifierResult struct {
	Score    float64 // 0 to 1
	Detail   string  // at most 1 KiB, printable text only
	Sandbox  Result  // how the verifier's own run went
	Snapshot SnapshotReport
}

// verifierLine is the one thing the verifier may say. Strict: an extra field is a refusal, so a verifier cannot be made to
// carry anything else out.
type verifierLine struct {
	Score  *float64 `json:"score"`
	Detail *string  `json:"detail"`
}

// ParseVerifierOutput reads the last non-empty line as {"score": 0..1, "detail": "..."} and refuses anything else. A bad
// line is the verifier's failure, never a score.
func ParseVerifierOutput(stdout []byte) (float64, string, error) {
	lines := strings.Split(strings.TrimSpace(string(stdout)), "\n")
	last := strings.TrimSpace(lines[len(lines)-1])
	if last == "" {
		return 0, "", fmt.Errorf("the verifier printed nothing")
	}
	var line verifierLine
	decoder := json.NewDecoder(bytes.NewReader([]byte(last)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&line); err != nil {
		return 0, "", fmt.Errorf("the verifier's last line is not a result: %w", err)
	}
	if decoder.More() {
		return 0, "", fmt.Errorf("the verifier's last line has more than one value")
	}
	if line.Score == nil || line.Detail == nil {
		return 0, "", fmt.Errorf("the verifier's line needs both a score and a detail")
	}
	if *line.Score < 0 || *line.Score > 1 || *line.Score != *line.Score {
		return 0, "", fmt.Errorf("the verifier's score %v is outside 0 to 1", *line.Score)
	}
	if len(*line.Detail) > 1024 {
		return 0, "", fmt.Errorf("the verifier's detail is longer than 1 KiB")
	}
	for _, r := range *line.Detail {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return 0, "", fmt.Errorf("the verifier's detail has a control character")
		}
	}
	return *line.Score, *line.Detail, nil
}

// Verify snapshots the agent's workspace, runs the verifier on the snapshot, and returns its judgement. The agent's workspace
// is not touched. A verifier that does not end normally, or whose output is not a result, is an error, not a zero.
func (v VerifierSpec) Verify(ctx context.Context, rt Runtime, workspace string, scratch string) (VerifierResult, error) {
	var out VerifierResult
	snapshot, err := os.MkdirTemp(scratch, "snapshot-")
	if err != nil {
		return out, err
	}
	defer os.RemoveAll(snapshot)
	out.Snapshot, err = Snapshot(workspace, snapshot, int64(v.Limits.DiskMiB)<<20)
	if err != nil {
		return out, err
	}
	if err := restoreProtected(v.Pristine, snapshot, v.Restore, int64(v.Limits.DiskMiB)<<20); err != nil {
		return out, err
	}
	out.Sandbox, err = rt.Run(ctx, Env{
		Rootfs: v.Rootfs, Workspace: snapshot, WorkDir: "/work", Argv: v.Argv, Env: v.Env, UID: v.UID, GID: v.GID, Limits: v.Limits,
		Mounts: []Mount{{Host: v.Hidden, Dest: "/verifier"}},
	})
	if err != nil {
		return out, err
	}
	if out.Sandbox.Verdict != "OK" {
		return out, fmt.Errorf("the verifier did not finish: %s", out.Sandbox.Verdict)
	}
	out.Score, out.Detail, err = ParseVerifierOutput(out.Sandbox.Stdout)
	return out, err
}

// restoreProtected replaces each protected path in the snapshot with the pristine copy (or removes it if there was none).
func restoreProtected(pristine, snapshot string, paths []string, bytesMax int64) error {
	for _, rel := range paths {
		target := filepath.Join(snapshot, rel)
		if err := os.RemoveAll(target); err != nil {
			return err
		}
		from := filepath.Join(pristine, rel)
		info, err := os.Lstat(from)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if info.IsDir() {
			if _, err := Snapshot(from, target, bytesMax); err != nil {
				return err
			}
		} else if info.Mode().IsRegular() {
			if _, err := copyRegular(from, target, bytesMax); err != nil {
				return err
			}
		}
	}
	return nil
}
